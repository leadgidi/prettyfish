"""Create a map from ordered pages and Mermaid diagrams."""
import argparse
import json
import sys
from pathlib import Path
from uuid import uuid4


def text(value, path):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{path} must be a non-empty string")
    return value


def items(value, key, path):
    if not isinstance(value, dict):
        raise ValueError(f"{path} must be an object")
    result = value.get(key)
    if not isinstance(result, list) or not result:
        raise ValueError(f"{path}.{key} must be a non-empty array")
    return result


def build_project(draft):
    pages = []
    for i, page in enumerate(items(draft, 'pages', 'draft')):
        page_path = f'pages[{i}]'
        diagrams = []
        for j, card in enumerate(items(page, 'diagrams', page_path)):
            path = f'{page_path}.diagrams[{j}]'
            if not isinstance(card, dict):
                raise ValueError(f'{path} must be an object')
            diagram = {
                'id': str(uuid4()),
                'name': text(card.get('name'), f'{path}.name'),
                'code': text(card.get('code'), f'{path}.code'),
                'x': 0,
                'y': 0,
                'width': 900,
                'mermaidTheme': 'blueprint',
                'configOverrides': {},
            }
            if 'description' in card:
                diagram['description'] = text(card['description'], f'{path}.description')
            diagrams.append(diagram)
        pages.append({
            'id': str(uuid4()),
            'name': text(page.get('name'), f'{page_path}.name'),
            'diagrams': diagrams,
            'activeDiagramId': diagrams[0]['id'],
        })
    return {'version': 1, 'pages': pages, 'activePageId': pages[0]['id']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('doc', type=Path)
    args = parser.parse_args()
    try:
        project = build_project(json.load(sys.stdin))
        with args.doc.open('x', encoding='utf-8') as output:
            output.write(json.dumps(project, indent=2, ensure_ascii=False) + '\n')
    except (ValueError, OSError) as error:
        parser.exit(1, f'Could not create {args.doc}: {error}\n')
    print(f'Created {args.doc}')


if __name__ == '__main__':
    main()
