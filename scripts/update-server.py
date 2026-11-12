#!/usr/bin/env python3
"""Update the systemd installation from a separate Git checkout, with Bitrix off."""
import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

SOURCE_DIRS = {'server', 'shared', 'scripts', 'web', 'tests'}
SOURCE_FILES = {'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
                '.env.example', 'BITRIX-EVENTS.md', 'UPDATE-SERVER.md'}
BITRIX_OFF = {name: 'false' for name in (
    'BITRIX_EVENTS_ENABLED', 'BITRIX_WRITE_ENABLED', 'BITRIX_CREATE_ENABLED',
    'BITRIX_IMPORT_NEW_ENABLED', 'BITRIX_CONTENT_ENABLED',
    'BITRIX_RECONCILE_ENABLED', 'BITRIX_IM_EVENTS_EXCLUSIVE',
    'BITRIX_POLL_ENABLED', 'BITRIX_ACTIVITY_ENABLED')}
BITRIX_OFF.update(BITRIX_WEBHOOK_FILE='', BITRIX_EVENT_TOKEN_FILE='')
CONFIG_DIR = Path('/etc/ruspet')
SYSTEMD_DIR = Path('/etc/systemd/system')
BACKUP_ROOT = Path('/root')
LOCK_FILE = Path('/run/lock/ruspet-update.lock')


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def output(args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def unit_value(unit, name):
    return output(['systemctl', 'show', unit, '--property=' + name, '--value'])


def source_files(source):
    if output(['git', '-C', str(source), 'status', '--porcelain', '--untracked-files=no']):
        raise RuntimeError('Git checkout has modified tracked files; commit or resolve them first.')
    names = output(['git', '-C', str(source), 'ls-files', '-z']).split('\0')
    selected = [Path(name) for name in names if name and
                (Path(name).parts[0] in SOURCE_DIRS or name in SOURCE_FILES)]
    required = {Path('package-lock.json'), Path('server/index.ts'),
                Path('scripts/migrate.ts'), Path('web/index.html')}
    if not required.issubset(selected):
        raise RuntimeError('Incomplete Git checkout.')
    for name in selected:
        if not (source / name).is_file() or (source / name).is_symlink():
            raise RuntimeError('Unexpected source file: ' + str(name))
    return selected


def safe_target(app, name):
    target = app / name
    # Reject symlink parents too: runtime files outside app must never be overwritten.
    if target.is_symlink() or not target.resolve().is_relative_to(app):
        raise RuntimeError('Unsafe application path: ' + str(name))
    for parent in target.parents:
        if parent == app:
            break
        if parent.is_symlink():
            raise RuntimeError('Symlink in application path: ' + str(name))
    return target


def runtime_context(pid):
    runtime = dict(item.split('=', 1) for item in
                   Path(f'/proc/{pid}/environ').read_bytes().decode().split('\0') if '=' in item)
    status = dict(line.split(':', 1) for line in
                  Path(f'/proc/{pid}/status').read_text().splitlines() if ':' in line)
    uid, gid = int(status['Uid'].split()[1]), int(status['Gid'].split()[1])
    groups = list(map(int, status.get('Groups', '').split()))
    executable = os.readlink(f'/proc/{pid}/exe')
    if Path(executable).name not in ('node', 'nodejs'):
        raise RuntimeError('ruspet.service MainPID must be Node.js; no changes made.')
    runtime['PATH'] = str(Path(executable).parent) + ':' + runtime.get('PATH', os.defpath)

    def permissions():
        os.setgroups(groups)
        os.setgid(gid)
        os.setuid(uid)

    return runtime, executable, uid, gid, permissions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', default='/opt/ruspet')
    parser.add_argument('--bitrix-disabled', action='store_true', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or sys.version_info < (3, 9):
        raise RuntimeError('Run as root with Python 3.9 or newer.')
    source, app = Path(__file__).resolve().parent.parent, Path(args.app).resolve()
    if source == app or not (app / 'package.json').is_file():
        raise RuntimeError('Use a separate Git checkout and an existing application directory.')
    with open(LOCK_FILE, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        install(source, app)


def install(source, app):
    files = source_files(source)
    for name in files + [Path('node_modules'), Path('dist')]:
        safe_target(app, name)
    if Path(unit_value('ruspet.service', 'WorkingDirectory')).resolve() != app:
        raise RuntimeError('Application directory does not match ruspet.service.')
    pid = int(unit_value('ruspet.service', 'MainPID') or '0')
    if pid <= 0:
        raise RuntimeError('ruspet.service must be running to read its actual database configuration.')
    runtime, node, uid, gid, permissions = runtime_context(pid)
    npm = shutil.which('npm', path=runtime['PATH'])
    dump, restore = shutil.which('pg_dump'), shutil.which('pg_restore')
    if not all((npm, dump, restore)):
        raise RuntimeError('npm, pg_dump and pg_restore are required; no changes made.')
    # Read through the app itself: dotenv and local connection-file rules stay identical.
    connection = json.loads(output([node, '--import', 'tsx', '--input-type=module', '-e',
                         "import {connectionString,pool} from './server/db.ts';import pg from 'pg';"
                         'const p=new pg.Client({connectionString}).connectionParameters;'
                         'process.stdout.write(JSON.stringify({host:p.host,port:p.port,user:p.user,'
                         'database:p.database,password:p.password,ssl:!!p.ssl}));await pool.end();'],
                        cwd=app, env={**runtime, 'DOTENV_CONFIG_QUIET': 'true'},
                        preexec_fn=permissions, stderr=subprocess.DEVNULL))
    if connection['ssl'] or not (connection['host'].startswith('/') or connection['host'] in ('localhost', '127.0.0.1', '::1')):
        raise RuntimeError('This server updater requires local PostgreSQL without TLS; no changes made.')
    dump_env = {**runtime, 'PGHOST': connection['host'], 'PGPORT': str(connection['port']),
                'PGUSER': connection['user'], 'PGDATABASE': connection['database'],
                'PGPASSWORD': connection['password'] or '', 'PGSSLMODE': 'disable', 'PGCONNECT_TIMEOUT': '15'}
    units = ['ruspet.service']
    for line in output(['systemctl', 'list-unit-files', '--type=service', '--no-legend', '--no-pager']).splitlines():
        unit = line.split()[0]
        if not unit.startswith('ruspet') or unit == 'ruspet.service':
            continue
        if Path(unit_value(unit, 'WorkingDirectory') or '/').resolve() != app:
            continue
        if unit in ('ruspet-bot-proxy.service', 'ruspet-viewer.service') or 'bitrix' in unit.lower() or 'scripts/bitrix.ts' in unit_value(unit, 'ExecStart'):
            units.append(unit)
    bitrix_units = [unit for unit in units if 'bitrix' in unit.lower() or
                    'scripts/bitrix.ts' in unit_value(unit, 'ExecStart')]
    active = [unit for unit in units if unit_value(unit, 'ActiveState') in ('active', 'activating')]
    restart = [unit for unit in active if unit not in bitrix_units]
    stage = Path(tempfile.mkdtemp(prefix='ruspet-release-', dir=app.parent))
    os.chown(stage, uid, gid)
    paused = False
    success = False
    try:
        for name in files:
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / name, target)
        for folder, dirs, names in os.walk(stage):
            os.chown(folder, uid, gid)
            for name in names:
                os.chown(Path(folder) / name, uid, gid)
        install_env = {key: value for key, value in runtime.items() if key in (
            'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'HTTP_PROXY',
            'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE')}
        install_env.update(GOMAXPROCS='1', npm_config_cache=str(stage / '.npm-cache'))
        print('Installing dependencies, checking TypeScript and building before downtime...', flush=True)
        for command in ([npm, 'ci', '--include=dev', '--no-audit', '--no-fund'],
                        [npm, 'run', 'check'], [npm, 'run', 'build']):
            run(command, cwd=stage, env=install_env, preexec_fn=permissions)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        backup = BACKUP_ROOT / ('ruspet-before-' + stamp)
        backup.mkdir(mode=0o700)
        (backup / 'runtime.json').write_text(json.dumps({'env': runtime, 'services': active,
                                                       'app': str(app), 'uid': uid, 'gid': gid}))
        print('Private recovery directory: ' + str(backup), flush=True)
        paused = True
        run(['systemctl', 'stop', *active])
        with tarfile.open(backup / 'code-and-config.tar.gz', 'w:gz') as archive:
            def include(info):
                parts = Path(info.name).parts
                return None if 'node_modules' in parts or '.git' in parts or '.npm-cache' in parts or '.local/postgres' in info.name else info
            archive.add(app, arcname='ruspet', filter=include)
        # Use the exact resolved pg parameters; credentials never appear in argv or logs.
        with open(backup / 'database.dump', 'xb') as destination:
            run([dump, '--format=custom', '--lock-wait-timeout=15s'], env=dump_env,
                stdout=destination, stderr=subprocess.DEVNULL, preexec_fn=permissions)
        run([restore, '--list', str(backup / 'database.dump')], stdout=subprocess.DEVNULL)
        disabled_file = CONFIG_DIR / 'bitrix-disabled.env'
        disabled_file.parent.mkdir(parents=True, exist_ok=True)
        disabled_file.write_text(''.join(name + '=' + value + '\n' for name, value in BITRIX_OFF.items()))
        for unit in units:
            dropin = SYSTEMD_DIR / (unit + '.d')
            dropin.mkdir(parents=True, exist_ok=True)
            config = '[Service]\nEnvironmentFile=' + str(disabled_file) + '\n'
            # Never start a former synchronization worker until this explicit block is removed.
            if unit in bitrix_units:
                config = '[Unit]\nConditionPathExists=!' + str(disabled_file) + '\n' + config
            (dropin / 'zzzz-ruspet-bitrix-off.conf').write_text(config)
        # The allowlist never contains .env, runtime settings, secrets, uploads or source data.
        for name in files:
            target = safe_target(app, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            for parent in target.parents:
                if parent == app:
                    break
                os.chown(parent, uid, gid)
            shutil.copy2(stage / name, target)
            os.chown(target, uid, gid)
        for name in ('node_modules', 'dist'):
            target = safe_target(app, Path(name))
            if target.exists():
                target.rename(stage / ('previous-' + name))
            (stage / name).rename(target)
        run([node, '--import', 'tsx', 'scripts/migrate.ts'], cwd=app,
            env={**runtime, **BITRIX_OFF}, preexec_fn=permissions)
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'start', *restart])
        run(['systemctl', 'is-active', '--quiet', *restart])
        url = 'http://127.0.0.1:' + runtime.get('PORT', '4310') + '/api/health'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for attempt in range(15):
            try:
                with opener.open(url, timeout=3) as response:
                    if json.load(response).get('ok') is not True:
                        raise ValueError('Unhealthy response')
                break
            except Exception:
                if attempt == 14:
                    raise RuntimeError('Local health check failed; inspect the services.') from None
                time.sleep(1)
        success = True
        print('Updated successfully. Bitrix is disabled; existing application settings are preserved.', flush=True)
    finally:
        if success or not paused:
            shutil.rmtree(stage)
        else:
            print('Update incomplete. Recovery files are under /root/ruspet-before-*; staging: ' + str(stage), flush=True)
            print('Inspect the failed step before restarting services; no automatic database rollback was attempted.', flush=True)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception as error:
        print('UPDATE STOPPED: ' + str(error), file=sys.stderr)
        sys.exit(1)
