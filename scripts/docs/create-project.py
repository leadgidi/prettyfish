"""Create a map from a Markdown draft with Mermaid fences."""
import argparse
import json
import re
from pathlib import Path
from uuid import uuid4


def parse_draft(source):
    pages = []
    page = card = None
    description = []
    code = None
    fence = ''
    for number, line in enumerate(source.splitlines(), 1):
        value = line.strip()
        if code is not None:
            if value != fence:
                code.append(line)
                continue
            if not any(part.strip() for part in code):
                raise ValueError(f'line {number}: empty Mermaid block')
            card['code'] = '\n'.join(code) + '\n'
            code = None
            continue
        if not value:
            continue
        heading = re.fullmatch(r'(#{1,2})\s+(.+)', value)
        if heading:
            if card is not None and 'code' not in card:
                raise ValueError(f'line {number}: add a Mermaid block to {card["name"]!r}')
            level, name = heading.groups()
            if level == '#':
                if page is not None and not page['diagrams']:
                    raise ValueError(f'line {number}: add a card to {page["name"]!r}')
                page = {'id': str(uuid4()), 'name': name, 'diagrams': []}
                pages.append(page)
                card = None
            else:
                if page is None:
                    raise ValueError(f'line {number}: start with a # page heading')
                card = {'id': str(uuid4()), 'name': name, 'x': 0, 'y': 0, 'width': 900,
                        'mermaidTheme': 'blueprint', 'configOverrides': {}}
                page['diagrams'].append(card)
                description = []
            continue
        opening = re.fullmatch(r'(`{3,})mermaid', value)
        if card is None or 'code' in card:
            raise ValueError(f'line {number}: expected a page or card heading')
        if opening:
            fence = opening[1]
            code = []
            if description:
                card['description'] = '\n'.join(description)
        elif value.startswith('```'):
            raise ValueError(f'line {number}: expected a ```mermaid block')
        else:
            description.append(value)

    if code is not None:
        raise ValueError(f'unclosed Mermaid block in {card["name"]!r}')
    if not pages:
        raise ValueError('start with a # page heading')
    if not page['diagrams']:
        raise ValueError(f'add a card to {page["name"]!r}')
    if 'code' not in card:
        raise ValueError(f'add a Mermaid block to {card["name"]!r}')
    for page in pages:
        page['activeDiagramId'] = page['diagrams'][0]['id']
    return {'version': 1, 'pages': pages, 'activePageId': pages[0]['id']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('doc', type=Path)
    parser.add_argument('draft', type=Path)
    args = parser.parse_args()
    try:
        project = parse_draft(args.draft.read_text(encoding='utf-8'))
        with args.doc.open('x', encoding='utf-8') as output:
            output.write(json.dumps(project, indent=2, ensure_ascii=False) + '\n')
    except (ValueError, OSError) as error:
        parser.exit(1, f'{args.draft}: {error}\n')


if __name__ == '__main__':
    main()
