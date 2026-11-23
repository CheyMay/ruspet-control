"""Build the PDF handbook and role sheets from the in-app guide. Requires ReportLab."""

import argparse
import json
import os
from pathlib import Path
from shutil import copyfile
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Paragraph


WIDTH, HEIGHT = A4
MARGIN = 49
INK = HexColor('#202C26')
MUTED = HexColor('#43574C')
GREEN = HexColor('#28523E')
LINE = HexColor('#C9D7CE')


def register_fonts():
    windows = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts'
    for directory, regular, bold in (
        (windows, 'segoeui.ttf', 'segoeuib.ttf'),
        (Path('/usr/share/fonts/truetype/dejavu'), 'DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'),
    ):
        if (directory / regular).exists() and (directory / bold).exists():
            pdfmetrics.registerFont(TTFont('Guide', str(directory / regular)))
            pdfmetrics.registerFont(TTFont('GuideBold', str(directory / bold)))
            return
    raise SystemExit('Install Segoe UI or DejaVu Sans to render Cyrillic.')


class GuidePage:
    def __init__(self, canvas, title, subtitle, page, total):
        self.canvas = canvas
        self.y = HEIGHT - 56
        self.text('РУСПЭТ', size=11, bold=True, color=GREEN, gap=11)
        self.text(title, size=27, bold=True, gap=3)
        self.text(subtitle, size=12, color=MUTED, gap=17)
        self.rule()
        canvas.setFont('Guide', 9)
        canvas.setFillColor(MUTED)
        canvas.drawString(MARGIN, 33, 'РУСПЭТ  /  Контроль и согласование задач')
        canvas.drawRightString(WIDTH - MARGIN, 33, f'{page} / {total}')

    def text(self, text, *, size=11, bold=False, color=INK, gap=4):
        style = ParagraphStyle('guide', fontName='GuideBold' if bold else 'Guide', fontSize=size,
                               leading=size * 1.35, alignment=TA_LEFT, textColor=color)
        paragraph = Paragraph(escape(text), style)
        _, height = paragraph.wrap(WIDTH - 2 * MARGIN, HEIGHT)
        if self.y - height < 60:
            raise ValueError(f'Text overflows the page: {text}')
        paragraph.drawOn(self.canvas, MARGIN, self.y - height)
        self.y -= height + gap

    def rule(self):
        self.canvas.setStrokeColor(LINE)
        self.canvas.line(MARGIN, self.y, WIDTH - MARGIN, self.y)
        self.y -= 13

    def steps(self, steps):
        for step in steps:
            self.text(step['name'], size=11, bold=True, color=GREEN, gap=2)
            self.text(step['text'], gap=8)


def save_handbook(out, guide):
    path = out / 'РУСПЭТ — гайд по разделам.pdf'
    canvas = Canvas(str(path), pagesize=A4)
    canvas.setAuthor('РУСПЭТ')
    canvas.setTitle('РУСПЭТ — гайд по разделам')
    modules = {module['id']: module for module in guide['modules']}
    day, decisions, team, settings = guide['chapters']
    pages = [(day['title'], day['modules']), (decisions['title'], decisions['modules'][:2]),
             ('Рабочий бот', decisions['modules'][2:]), (team['title'], team['modules']),
             (settings['title'], settings['modules'][:3]), ('Доступы и подключения', settings['modules'][3:])]
    for index, (title, ids) in enumerate(pages, 1):
        page = GuidePage(canvas, title, 'Гайд по разделам', index, len(pages))
        for module_id in ids:
            module = modules[module_id]
            page.text(module['title'], size=15, bold=True, gap=3)
            page.text(module['lead'], size=11, color=MUTED, gap=8)
            page.steps(module['steps'])
            page.y -= 8
        canvas.showPage()
    canvas.save()
    return path


def save_roles(out, guide, training):
    roles_dir = out / 'Памятки'
    roles_dir.mkdir(exist_ok=True)
    files = []
    for role in guide['roles']:
        title = 'Менеджер' if role['id'] == 'employee' else role['title']
        path = roles_dir / f'{title}.pdf'
        canvas = Canvas(str(path), pagesize=A4)
        canvas.setAuthor('РУСПЭТ')
        canvas.setTitle(f'Памятка — {title}')
        page = GuidePage(canvas, title, 'Памятка по работе в системе', 1, 1)
        track = training['tracks'].get(role['id'])
        page.text(track['summary'] if track else role['lead'], size=12, color=MUTED, gap=14)
        if track:
            for lesson_id in track['desktop']:
                lesson = training['lessons'][lesson_id]
                page.steps([{'name': lesson['title'], 'text': lesson['action']}])
        else:
            page.steps(role['steps'])
        page.y -= 8
        page.rule()
        page.text('Чтобы потренироваться на примерах, откройте «Гайд» в верхней панели и нажмите «Начать обучение».',
                  size=10, color=MUTED)
        canvas.save()
        files.append(path)
    package = out / 'РУСПЭТ — памятки по ролям.zip'
    with ZipFile(package, 'w', ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, path.name)
    return package, files


def save_briefing(out, briefing):
    path = out / 'РУСПЭТ — шпаргалка для обучения.pdf'
    canvas = Canvas(str(path), pagesize=A4)
    canvas.setAuthor('РУСПЭТ')
    canvas.setTitle(briefing['title'])
    sections = briefing['sections']
    for index, section in enumerate(sections, 1):
        page = GuidePage(canvas, section['title'], briefing['title'] + ' · ' + briefing['subtitle'].lower(),
                         index, len(sections))
        if 'intro' in section:
            page.text(section['intro'], size=11, color=MUTED, gap=13)
        page.steps(section['steps'])
        canvas.showPage()
    canvas.save()
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path, help='Directory for the handbook, individual PDFs and ZIP.')
    parser.add_argument('--release-dir', type=Path, help='Copy the downloads into server/training for a release.')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    shared = Path(__file__).resolve().parents[1] / 'shared'
    guide = json.loads((shared / 'workspace-guide.json').read_text(encoding='utf-8'))
    training = json.loads((shared / 'workspace-training.json').read_text(encoding='utf-8'))
    briefing = json.loads((shared / 'workspace-briefing.json').read_text(encoding='utf-8'))
    register_fonts()
    handbook = save_handbook(args.output, guide)
    roles, role_files = save_roles(args.output, guide, training)
    owner = save_briefing(args.output, briefing)
    complete = args.output / 'РУСПЭТ — комплект для обучения.zip'
    with ZipFile(complete, 'w', ZIP_DEFLATED) as archive:
        for path in (owner, handbook):
            archive.write(path, path.name)
        for path in role_files:
            archive.write(path, 'Памятки/' + path.name)
    if args.release_dir:
        args.release_dir.mkdir(parents=True, exist_ok=True)
        for path, file in ((owner, 'briefing.pdf'), (handbook, 'handbook.pdf'), (roles, 'roles.zip'),
                           (complete, 'complete.zip')):
            copyfile(path, args.release_dir / file)


if __name__ == '__main__':
    main()
