"""Read Bitrix's HTML .xls without Excel dependencies; keep company data private."""
import argparse
import collections
import datetime
import json
import os
import re
from html.parser import HTMLParser
from pathlib import Path


class Table(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self.row, self.cell = [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == 'tr':
            self.row = []
        if tag in ('td', 'th') and self.row is not None:
            self.cell = []
        if tag == 'br' and self.cell is not None:
            self.cell.append('\n')

    def handle_endtag(self, tag):
        if tag in ('td', 'th') and self.cell is not None:
            self.row.append(''.join(self.cell).strip())
            self.cell = None
        if tag == 'tr' and self.row is not None:
            if self.row:
                self.rows.append(self.row)
            self.row = None

    def handle_data(self, text):
        if self.cell is not None:
            self.cell.append(text)


def records(rows):
    if not rows or not {'ID', 'Название', 'Описание', 'Крайний срок', 'Статус', 'Исполнитель'} <= set(rows[0]):
        raise ValueError('Missing required export columns')
    if len(set(rows[0])) != len(rows[0]):
        raise ValueError('Duplicate export columns')
    result = {}
    for row in rows[1:]:
        if len(row) != len(rows[0]):
            raise ValueError('Inconsistent export row width')
        record = dict(zip(rows[0], row))
        task_id = str(record['ID']).strip()
        if not re.fullmatch(r'[1-9][0-9]{0,17}', task_id) or task_id in result:
            raise ValueError('Invalid or duplicate task ID')
        result[task_id] = record
    return result


def normalized(value, field):
    text = str(value or '').strip().replace('\r\n', '\n').replace('\xa0', ' ')
    if not text:
        return ''
    if field in ('Крайний срок', 'Дата создания', 'Дата изменения', 'Дата закрытия'):
        for pattern in ('%d.%m.%Y %H:%M:%S', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M:%S'):
            try:
                # Both exports use Moscow wall time. Preserve that assumption explicitly.
                return datetime.datetime.strptime(text, pattern).isoformat() + '+03:00'
            except ValueError:
                pass
        raise ValueError('Unsupported date format')
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('input')
    parser.add_argument('--baseline', default='data/first-sheet.json')
    parser.add_argument('--output', required=True, help='Private destination outside tracked source data')
    args = parser.parse_args()
    table = Table()
    table.feed(Path(args.input).read_text(encoding='utf-8-sig'))
    current = records(table.rows)
    baseline = records(json.loads(Path(args.baseline).read_text())['rows'])
    common = current.keys() & baseline.keys()
    fields = ['Название', 'Описание', 'Крайний срок', 'Статус', 'Исполнитель', 'Постановщик', 'Цена задачи']
    changes = {field: sum(normalized(current[i].get(field), field) != normalized(baseline[i].get(field), field)
                          for i in common) for field in fields}
    report = {'exportTasks': len(current), 'baselineTasks': len(baseline), 'matchedIds': len(common),
              'newIds': len(current.keys() - baseline.keys()), 'absentIds': len(baseline.keys() - current.keys()),
              'changedFields': changes,
              'descriptionWhitespaceOnly': sum(
                  normalized(current[i].get('Описание'), 'Описание') != normalized(baseline[i].get('Описание'), 'Описание')
                  and re.sub(r'\s+', ' ', normalized(current[i].get('Описание'), 'Описание')).strip() ==
                      re.sub(r'\s+', ' ', normalized(baseline[i].get('Описание'), 'Описание')).strip() for i in common),
              'timezoneAssumption': 'Europe/Moscow',
              'deletionsInferred': False,
              'statuses': dict(collections.Counter(r['Статус'] for r in current.values()))}
    # Exclusive creation prevents accidentally overwriting a snapshot or following a symlink.
    with open(args.output, 'x', encoding='utf-8', opener=lambda path, flags: os.open(path, flags, 0o600)) as out:
        json.dump({'file': Path(args.input).name, 'sheet': 'Bitrix export', 'rows': table.rows, 'comparison': report},
                  out, ensure_ascii=False)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
