"""Deployment orchestration tests. No real services, credentials or databases used."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('update_server', Path(__file__).resolve().parents[1] / 'scripts/update-server.py')
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class UpdateServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.old_mask = os.umask(0o077)

    def tearDown(self):
        os.umask(self.old_mask)
        self.temp.cleanup()

    def test_symlink_destinations_and_parents_are_rejected(self):
        app, outside = self.root / 'app', self.root / 'outside'
        app.mkdir()
        outside.mkdir()
        (app / 'server').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'Unsafe|Symlink'):
            update.safe_target(app, Path('server/index.ts'))
        (app / 'direct').symlink_to(outside / 'file')
        with self.assertRaisesRegex(RuntimeError, 'Unsafe'):
            update.safe_target(app, Path('direct'))

    def test_dirty_git_checkout_is_rejected(self):
        with patch.object(update, 'output', return_value=' M server/index.ts'):
            with self.assertRaisesRegex(RuntimeError, 'modified tracked'):
                update.source_files(self.root)

    def exercise(self, failure=None):
        source, app = self.root / 'source', self.root / 'app'
        for directory in (source / 'scripts', source / 'server', app / 'server',
                          app / 'node_modules', app / 'dist'):
            directory.mkdir(parents=True, exist_ok=True)
        (source / 'server/index.ts').write_text('new code')
        (source / 'package.json').write_text('{}')
        (app / 'server/index.ts').write_text('old code')
        (app / 'package.json').write_text('{}')
        (app / '.env').write_text('DATABASE_URL=private-test-value\n')
        (app / '.secrets').mkdir()
        (app / '.secrets/token').write_text('private-test-token')
        (app / 'node_modules/old').write_text('old dependency')
        (app / 'dist/index.html').write_text('old build')
        backups = self.root / 'backups'
        backups.mkdir()
        commands = []
        environment = {'PATH': '/usr/bin', 'DATABASE_URL': 'private-test-database'}

        def unit_value(unit, name):
            return {'WorkingDirectory': str(app), 'MainPID': '123',
                    'ActiveState': 'active', 'ExecStart':
                    'node scripts/bitrix.ts events' if 'bitrix' in unit else 'node server/index.ts'}[name]

        def output(command, **kwargs):
            if command[0] == 'systemctl':
                return 'ruspet.service enabled\nruspet-bot-proxy.service enabled\nruspet-bitrix.service enabled'
            return json.dumps({'host': '/run/postgresql', 'port': 5432, 'user': 'fictional-user',
                               'database': 'fictional-db', 'password': 'private-test-password', 'ssl': False})

        def run(command, **kwargs):
            commands.append((command, kwargs))
            if failure == 'build' and command[1:] == ['run', 'build']:
                raise subprocess.CalledProcessError(1, command)
            if command[0] == '/fake/pg_dump':
                if failure == 'dump':
                    raise subprocess.CalledProcessError(1, command)
                kwargs['stdout'].write(b'fictional dump')
            if command[1:2] == ['ci']:
                (kwargs['cwd'] / 'node_modules').mkdir()
                (kwargs['cwd'] / 'node_modules/new').write_text('new dependency')
            if command[1:] == ['run', 'build']:
                (kwargs['cwd'] / 'dist').mkdir()
                (kwargs['cwd'] / 'dist/index.html').write_text('new build')

        changes = {'__file__': str(source / 'scripts/update-server.py'),
                   'CONFIG_DIR': self.root / 'etc', 'SYSTEMD_DIR': self.root / 'systemd',
                   'BACKUP_ROOT': backups, 'LOCK_FILE': self.root / 'lock',
                   'source_files': lambda _: [Path('server/index.ts'), Path('package.json')],
                   'runtime_context': lambda _: (environment, '/fake/node', os.getuid(), os.getgid(), lambda: None),
                   'unit_value': unit_value, 'output': output, 'run': run}
        logs = io.StringIO()
        response = io.BytesIO(b'{"ok":true}')
        with contextlib.ExitStack() as stack:
            for name, value in changes.items():
                stack.enter_context(patch.object(update, name, value))
            stack.enter_context(patch.object(update.os, 'geteuid', return_value=0))
            stack.enter_context(patch.object(update.shutil, 'which', side_effect=lambda name, **_: '/fake/' + name))
            stack.enter_context(patch.object(update.urllib.request.OpenerDirector, 'open', return_value=response))
            stack.enter_context(patch.object(update.sys, 'argv', ['update-server.py', '--app', str(app), '--bitrix-disabled']))
            stack.enter_context(contextlib.redirect_stdout(logs))
            if failure:
                with self.assertRaises(subprocess.CalledProcessError):
                    update.main()
            else:
                update.main()
        self.assertNotIn('private-test-', logs.getvalue())
        self.assertNotIn('private-test-', repr([command for command, _ in commands]))
        self.assertEqual((app / '.env').read_text(), 'DATABASE_URL=private-test-value\n')
        self.assertEqual((app / '.secrets/token').read_text(), 'private-test-token')
        return app, backups, commands

    def test_success_preserves_secrets_backs_up_actual_database_and_disables_bitrix(self):
        app, backups, commands = self.exercise()
        self.assertEqual((app / 'server/index.ts').read_text(), 'new code')
        self.assertEqual((app / 'node_modules/new').read_text(), 'new dependency')
        self.assertEqual((app / 'dist/index.html').read_text(), 'new build')
        self.assertEqual(len(list(backups.glob('*/database.dump'))), 1)
        for entry in backups.glob('*/*'):
            self.assertEqual(entry.stat().st_mode & 0o077, 0)
        dump = next(options for command, options in commands if command[0] == '/fake/pg_dump')
        self.assertEqual(dump['env']['PGDATABASE'], 'fictional-db')
        self.assertEqual(dump['env']['PGHOST'], '/run/postgresql')
        self.assertEqual(dump['env']['PGUSER'], 'fictional-user')
        self.assertEqual(dump['env']['PGPASSWORD'], 'private-test-password')
        start = next(command for command, _ in commands if command[:2] == ['systemctl', 'start'])
        self.assertEqual(start[2:], ['ruspet.service', 'ruspet-bot-proxy.service'])
        migration = next(options for command, options in commands if command[-1] == 'scripts/migrate.ts')
        self.assertEqual(migration['env']['BITRIX_WRITE_ENABLED'], 'false')
        self.assertEqual(migration['env']['DATABASE_URL'], 'private-test-database')
        self.assertEqual(migration['env']['BITRIX_WEBHOOK_FILE'], '')
        off = self.root / 'etc/bitrix-disabled.env'
        self.assertIn('BITRIX_WRITE_ENABLED=false\n', off.read_text())
        self.assertIn('BITRIX_EVENT_TOKEN_FILE=\n', off.read_text())
        for unit in ('ruspet.service', 'ruspet-bot-proxy.service', 'ruspet-bitrix.service'):
            text = (self.root / 'systemd' / (unit + '.d') / 'zzzz-ruspet-bitrix-off.conf').read_text()
            self.assertIn('EnvironmentFile=' + str(off), text)
            if 'bitrix' in unit:
                self.assertIn('ConditionPathExists=!' + str(off), text)
        actions = [command for command, _ in commands]
        self.assertLess(next(i for i, command in enumerate(actions) if command[1:] == ['run', 'build']),
                        next(i for i, command in enumerate(actions) if command[:2] == ['systemctl', 'stop']))

    def test_build_failure_never_stops_services(self):
        app, backups, commands = self.exercise('build')
        self.assertFalse(any(command[:2] == ['systemctl', 'stop'] for command, _ in commands))
        self.assertEqual((app / 'server/index.ts').read_text(), 'old code')
        self.assertFalse(list(backups.iterdir()))
        self.assertFalse(list(self.root.glob('ruspet-release-*')))

    def test_dump_failure_never_installs_code_or_restarts_services(self):
        app, backups, commands = self.exercise('dump')
        self.assertEqual((app / 'server/index.ts').read_text(), 'old code')
        self.assertFalse(any(command[:2] == ['systemctl', 'start'] for command, _ in commands))
        self.assertTrue(list(backups.glob('*/code-and-config.tar.gz')))


if __name__ == '__main__':
    unittest.main()
