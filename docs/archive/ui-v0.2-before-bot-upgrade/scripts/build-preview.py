from pathlib import Path
import base64
import json
import re

project = Path(__file__).resolve().parents[1]
destination = Path('/Users/itawjh/.codex/visualizations/2026/10/21/01a15f4a-f0c9-7f90-847d-bbe339786b18/cute-team-workbench.html')
source = (project / 'index.html').read_text()
fragment = source[source.index('<div id="creative-workbench-v2"'):source.rindex('</body>')]
fragment = fragment.replace('id="creative-workbench-v2" class="app-shell"', 'id="creative-workbench-v2" class="app-shell" data-inline="true"', 1)
fragment = fragment.replace(' tabindex="-1"', '')

def icon(match):
    markup = match.group(0)
    if '17.2' in markup:
        name = 'star'
    elif '<circle' in markup:
        name = 'search'
    elif 'M5 12h14' in markup:
        name = 'arrow-right'
    else:
        name = 'x'
    css_class = ' class="filter-star"' if 'filter-star' in markup else ''
    return '<i data-lucide="' + name + '" aria-hidden="true"' + css_class + '></i>'

fragment = re.sub(r'<svg\b[^>]*>.*?</svg>', icon, fragment, flags=re.S)

def control(match):
    tag = match.group(0)
    if 'class="' in tag:
        return tag.replace('class="', 'class="cursor-interaction ', 1)
    return tag[:-1] + ' class="cursor-interaction">'

fragment = re.sub(r'<(?:button|a)\b[^>]*>', control, fragment)
css = (project / 'styles.css').read_text()
css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
root = '#creative-workbench-v2'

def scope_rule(match):
    prefix = match.group(1)
    if prefix.strip().startswith('@'):
        return prefix + '{'
    result = []
    for selector in prefix.split(','):
        selector = selector.strip()
        if selector in (':root', 'html', 'body'):
            result.append(root)
        elif selector.startswith('*'):
            result.extend([root + selector[1:], root + ' ' + selector])
        elif selector.startswith('::'):
            result.append(root + ' ' + selector)
        else:
            result.append(root + ' ' + selector)
    return ','.join(result) + '{'

css = re.sub(r'([^{}]+)\{', scope_rule, css)
css = css.replace('color-scheme:light;', 'color-scheme:inherit;')
css = css.replace('min-width:320px;', 'min-width:0;')
css = css.replace('cursor:pointer;', '')
palette = {
    'page':('#fff','#171a17'),'surface':('#fff','#202520'),
    'muted-surface':('#f4f4f1','#2b312b'),'subtle-surface':('#fafaf8','#242a24'),
    'image-matte':('#eef7e9','#293a2a'),'portrait-peach':('#fff1e8','#3e3129'),
    'portrait-lilac':('#f3edff','#34303e'),'portrait-blue':('#ebf3ff','#293340'),
    'ink':('#101110','#edf1e9'),'muted':('#666861','#b4beae'),
    'faint':('#73776b','#abb5a3'),'line':('#101110','#d8e2d0'),
    'soft-line':('#dedfd8','#485242'),'accent':('#c9ff85','#c9ff85'),
    'accent-soft':('#eff8e6','#304327'),'accent-ink':('#182311','#e3f4d3'),
    'danger':('#a73f36','#f2a193'),'danger-soft':('#fff0eb','#432b27'),
    'overlay':('#10111079','#050805a6'),'shadow':('#10111012','#05080570'),
    'focus':('#638d37','#a9d282')
}
for token, (light, dark) in palette.items():
    css = re.sub(r'--color-' + re.escape(token) + r':[^;]+;', '--color-' + token + ':light-dark(' + light + ',' + dark + ');', css)
css += '\n' + root + ' .skip-link{' + 'position:absolute;' + '}\n'
css += root + ' .detail-layout{grid-template-columns:minmax(200px,.8fr) minmax(0,1.2fr)}\n'
css += '@media(max-width:640px){' + root + ' .detail-layout{grid-template-columns:minmax(0,1fr)}}\n'

employees_js = (project / 'data/employees.js').read_text()
employees = json.loads(employees_js[employees_js.index('['):employees_js.rindex(']')+1])
for employee in employees:
    data = base64.b64encode((project / employee['thumb']).read_bytes()).decode()
    employee['portrait'] = employee['thumb'] = 'data:image/webp;base64,' + data
data_script = 'window.TEAM_EMPLOYEES=' + json.dumps(employees, ensure_ascii=False, separators=(',', ':')) + ';'
app_script = (project / 'app.js').read_text()
fragment = fragment.replace('data-inline="true">', 'data-inline="true">\n<style>\n' + css + '\n</style>', 1)
fragment += '\n<script>\n' + data_script.replace('</script', '<\\/script') + '\n</script>\n'
fragment += '<script>\n' + app_script.replace('</script', '<\\/script') + '\n</script>\n'
assert '<!doctype' not in fragment.lower()
assert '<svg' not in fragment
assert len(fragment.encode()) < 1_000_000
assert 'fetch(' not in fragment
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(fragment)
assert destination.read_text() == fragment
print(json.dumps({'path':str(destination),'bytes':len(fragment.encode()),'portraits':len(employees)},ensure_ascii=False))
