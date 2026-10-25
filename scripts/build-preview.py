"""Build the conversation preview from the actual local application.

All classic scripts are read from index.html in document order. No preview-only
copy of the application is kept.
"""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit
import base64
import colorsys
import json
import io
from PIL import Image
import re

PROJECT = Path(__file__).resolve().parents[1]
DESTINATION = Path('/Users/itawjh/.codex/visualizations/2026/10/21/01a15f4a-f0c9-7f90-847d-bbe339786b18/cute-team-workbench.html')
ROOT = '#creative-workbench-v2'


class PageScripts(HTMLParser):
    """Collect scripts, including scripts in the head, in their original order."""
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.scripts = []
        self.current = None

    def handle_starttag(self, tag, attrs):
        if tag.lower() == 'script':
            self.current = {'attrs': dict(attrs), 'parts': []}

    def handle_data(self, data):
        if self.current is not None:
            self.current['parts'].append(data)

    def handle_endtag(self, tag):
        if tag.lower() == 'script' and self.current is not None:
            self.scripts.append(self.current)
            self.current = None


def local_path(source):
    parsed = urlsplit(source)
    if parsed.scheme or parsed.netloc or source.startswith('/'):
        raise ValueError('Preview resources must be project-relative: ' + source)
    path = (PROJECT / unquote(parsed.path)).resolve()
    if PROJECT not in path.parents:
        raise ValueError('Resource escapes the application directory: ' + source)
    return path


def employees_script(path):
    source = path.read_text(encoding='utf-8')
    assignment = re.search(r'\b(?:window\.)?TEAM_EMPLOYEES\s*=\s*', source)
    if not assignment:
        raise ValueError('employees.js must assign TEAM_EMPLOYEES as a JSON array.')
    employees, _ = json.JSONDecoder().raw_decode(source[assignment.end():])
    if not isinstance(employees, list) or len(employees) != 21:
        raise ValueError('Expected the existing 21 employee portraits.')
    for employee in employees:
        image = local_path(employee['thumb'])
        if image.suffix.lower() != '.webp':
            raise ValueError('The inline preview uses the small WebP thumbnails.')
        data = base64.b64encode(image.read_bytes()).decode('ascii')
        employee['portrait'] = employee['thumb'] = 'data:image/webp;base64,' + data
    return 'window.TEAM_EMPLOYEES=' + json.dumps(employees, ensure_ascii=False, separators=(',', ':')) + ';', len(employees)


def split_selectors(value):
    """Keep commas inside :is(...), :has(...), and attributes intact."""
    result, start, depth, quote, escaped = [], 0, 0, None, False
    for index, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if char == '\\':
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in ('"', "'"):
            quote = char
        elif char in '([':
            depth += 1
        elif char in ')]':
            depth -= 1
        elif char == ',' and depth == 0:
            result.append(value[start:index].strip())
            start = index + 1
    result.append(value[start:].strip())
    return [selector for selector in result if selector]


def scope_selector(selector):
    # These classes live on the application root itself, not below it.
    if selector.startswith(ROOT):
        return [selector]
    if re.match(r'^(?:\.app-shell|\.sidebar-open)(?=$|[\s.#:[>+~])', selector):
        return [ROOT + selector]
    if re.match(r'^(?:html|body|:root)(?=$|[\s.#:[>+~])', selector):
        selector = re.sub(r'^(?:html|body|:root)', ROOT, selector, count=1)
        selector = re.sub(re.escape(ROOT) + r'\s+(?:html|body)(?=$|[\s.#:[>+~])', ROOT, selector)
        return [selector]
    if selector.startswith('*'):
        return [ROOT + selector[1:], ROOT + ' ' + selector]
    return [ROOT + ' ' + selector]


def block_end(css, opening):
    depth, quote, escaped = 1, None, False
    for index in range(opening + 1, len(css)):
        char = css[index]
        if escaped:
            escaped = False
            continue
        if char == '\\':
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in ('"', "'"):
            quote = char
        elif char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                return index
    raise ValueError('Unbalanced CSS block.')


def scope_css(css):
    """Scope ordinary selectors recursively; leave keyframe percentages intact."""
    result, cursor = [], 0
    while cursor < len(css):
        opening = css.find('{', cursor)
        if opening < 0:
            tail = css[cursor:].strip()
            if tail:
                result.append(tail)
            break
        prelude = css[cursor:opening].strip()
        closing = block_end(css, opening)
        body = css[opening + 1:closing]
        if prelude.startswith('@'):
            if re.match(r'^@(?:media|supports|container|layer|document)\b', prelude):
                body = scope_css(body)
            result.append(prelude + '{' + body + '}')
        else:
            selectors = [scoped for selector in split_selectors(prelude) for scoped in scope_selector(selector)]
            result.append(','.join(selectors) + '{' + body + '}')
        cursor = closing + 1
    return '\n'.join(result)


def theme_literal(match):
    """Derive product-specific dark colors instead of using viz utility tokens."""
    light = match.group(0).lower()
    value = light[1:]
    if len(value) in (3, 4):
        value = ''.join(char * 2 for char in value)
    if len(value) not in (6, 8):
        return light
    alpha = value[6:]
    rgb = tuple(int(value[index:index + 2], 16) / 255 for index in (0, 2, 4))
    hue, luminance, saturation = colorsys.rgb_to_hls(*rgb)
    if alpha and luminance < .5:
        dark = '#030603' + alpha
    else:
        if luminance >= .78:
            dark_luminance = .13 + (1 - luminance) * .9
            dark_saturation = min(saturation, .22)
        elif luminance <= .5:
            dark_luminance = .9 - luminance * .36
            dark_saturation = min(saturation, .32)
        else:
            dark_luminance = .69 + (.7 - luminance) * .25
            dark_saturation = min(saturation, .34)
        dark_rgb = colorsys.hls_to_rgb(hue, dark_luminance, dark_saturation)
        dark = '#' + ''.join(format(round(channel * 255), '02x') for channel in dark_rgb) + alpha
    return 'light-dark(' + light + ',' + dark + ')'


def preview_css(source):
    css = re.sub(r'/\*.*?\*/', '', source, flags=re.S)
    if re.search(r'@(?:import|charset)\b', css):
        raise ValueError('Inline preview CSS cannot load external stylesheets.')
    css = scope_css(css)
    css = re.sub(r'(?<![\w-])#[0-9a-fA-F]{3,8}(?![\w-])', theme_literal, css)
    css = re.sub(r'color-scheme\s*:\s*light\s*;', 'color-scheme:inherit;', css)
    css = re.sub(r'min-width\s*:\s*320px\s*;', 'min-width:0;', css)
    css = re.sub(r'cursor\s*:\s*pointer\s*;', '', css)
    # Keep the approved silver / forest-green product palette.
    # Luminance adaptation above is only for the conversation host theme.
    # The host measures content height. Keep app geometry but remove viewport
    # containers, fixed overlays, and nested conversation scrolling.
    css += '\n' + '\n'.join([
        ROOT + '[data-inline="true"]{height:auto!important;min-height:0!important;max-height:none!important;max-width:100%;overflow:visible!important;position:relative;}',
        ROOT + ' .workspace-main,' + ROOT + ' #main-content{height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;}',
        ROOT + ' .studio-sidebar{position:relative!important;inset:auto!important;height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;transform:none!important;align-self:stretch;}',
        ROOT + ' .workspace-topbar{position:relative!important;inset:auto!important;}',
        ROOT + ' .conversation-stream{height:auto!important;min-height:240px;max-height:none!important;overflow:visible!important;}',
        ROOT + ' .skip-link{position:absolute!important;}',
        ROOT + ' .toast{position:relative!important;left:auto!important;bottom:auto!important;transform:none!important;grid-column:1/-1;justify-self:center;margin:12px;}',
        ROOT + ' .studio-dialog{position:relative!important;inset:auto!important;max-height:none!important;}',
        ROOT + ' .sidebar-scrim{display:none!important;}',
        '@media(max-width:760px){' + ROOT + ' .studio-sidebar{display:none!important;width:100%!important;border-right:0;border-bottom:1px solid var(--color-soft-line);box-shadow:none;}' + ROOT + '.sidebar-open .studio-sidebar{display:flex!important;}' + ROOT + ' .sidebar-bottom{margin-top:14px;}}',
    ])
    return css


def icon(match):
    markup = match.group(0)
    if '17.2' in markup:
        name = 'star'
    elif 'm7 23' in markup:
        name = 'clapperboard'
    elif 'm6 6 12 12' in markup or 'M18 6 6 18' in markup:
        name = 'x'
    elif 'M12 5v14' in markup or 'M12 6v12' in markup:
        name = 'plus'
    elif 'M4 6h16' in markup:
        name = 'menu'
    elif '<circle cx="9"' in markup:
        name = 'users'
    elif '<circle' in markup:
        name = 'search'
    elif '<rect x="4"' in markup:
        name = 'layout-dashboard'
    elif '<rect x="3.5"' in markup:
        name = 'columns-3'
    elif 'M4 5h16' in markup:
        name = 'messages-square'
    elif 'M3.5 7' in markup:
        name = 'folder-open'
    elif 'm9 15' in markup:
        name = 'link'
    elif 'M5 12h14' in markup:
        name = 'arrow-right'
    else:
        name = 'file-text'
    css_class = ' class="filter-star"' if 'filter-star' in markup else ''
    return '<i data-lucide="' + name + '" aria-hidden="true"' + css_class + '></i>'


def control(match):
    tag = match.group(0)
    if 'cursor-interaction' in tag:
        return tag
    if 'class="' in tag:
        return tag.replace('class="', 'class="cursor-interaction ', 1)
    return tag[:-1] + ' class="cursor-interaction">'


def inline_scenes(fragment):
    """Embed scene literals after every application module has been collected."""
    references = sorted(set(re.findall(r'assets/(?:scenes|projects)/[a-z0-9-]+\.webp', fragment)))
    missing = [reference for reference in references if not local_path(reference).is_file()]
    if missing:
        raise FileNotFoundError('Scene images missing; preview was not updated: ' + ', '.join(missing))
    for reference in references:
        with Image.open(local_path(reference)) as image:
            image.thumbnail((720, 450))
            buffer = io.BytesIO()
            image.save(buffer, format='WEBP', quality=68, method=6)
            data = base64.b64encode(buffer.getvalue()).decode('ascii')
        fragment = fragment.replace(reference, 'data:image/webp;base64,' + data)
    return fragment, references


def build():
    source = (PROJECT / 'index.html').read_text(encoding='utf-8')
    scripts = PageScripts()
    scripts.feed(source)
    root_match = re.search(r'<div\b[^>]*\bid=["\']creative-workbench-v2["\'][^>]*>', source, flags=re.I)
    body_end = re.search(r'</body\s*>', source, flags=re.I)
    if not root_match or not body_end:
        raise ValueError('The application shell or body boundary is missing.')
    fragment = source[root_match.start():body_end.start()]
    # Head scripts were collected above. Remove every original script tag, then
    # append the inlined dependencies exactly once at the end.
    fragment = re.sub(r'<script\b[^>]*>.*?</script\s*>', '', fragment, flags=re.S | re.I)
    opening = root_match.group(0)
    inline_opening = re.sub(r'\sdata-inline=["\'][^"\']*["\']', '', opening)[:-1] + ' data-inline="true">'
    fragment = fragment.replace(opening, inline_opening, 1)
    fragment = re.sub(r'\s+tabindex=["\']-1["\']', '', fragment)
    fragment = re.sub(r'<svg\b[^>]*>.*?</svg>', icon, fragment, flags=re.S | re.I)
    fragment = re.sub(r'<(?:button|a)\b[^>]*>', control, fragment, flags=re.I)
    stylesheets = re.findall(r'<link\b(?=[^>]*rel=[\"\']stylesheet[\"\'])(?=[^>]*href=[\"\']([^\"\']+)[\"\'])[^>]*>', source, flags=re.I)
    if not stylesheets:
        raise ValueError('No stylesheets found in index.html.')
    css = preview_css('\n'.join(local_path(href).read_text(encoding='utf-8') for href in stylesheets))
    fragment = fragment.replace(inline_opening, inline_opening + '\n<style>\n' + css + '\n</style>', 1)
    portrait_count, loaded = 0, []
    for script in scripts.scripts:
        attrs = script['attrs']
        if attrs.get('src'):
            path = local_path(attrs['src'])
            if path in loaded:
                raise ValueError('Duplicate script dependency in index.html: ' + attrs['src'])
            loaded.append(path)
            if path == PROJECT / 'data/employees.js':
                javascript, portrait_count = employees_script(path)
            else:
                javascript = path.read_text(encoding='utf-8')
        else:
            javascript = ''.join(script['parts'])
        if attrs.get('type') not in (None, '', 'text/javascript', 'application/javascript'):
            raise ValueError('This no-build preview expects classic application scripts.')
        javascript = re.sub(r'</script', r'<\\/script', javascript, flags=re.I)
        fragment += '\n<script>\n' + javascript + '\n</script>\n'
    fragment, scene_images = inline_scenes(fragment)
    assert portrait_count == 21, 'index.html must load data/employees.js.'
    assert '<!doctype' not in fragment.lower()
    assert not re.search(r'<script\b[^>]*\bsrc\s*=', fragment, flags=re.I)
    assert not re.search(r'\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(', fragment)
    assert len(fragment.encode('utf-8')) < 1_000_000, 'Inline preview exceeds the 1 MB limit.'
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    DESTINATION.write_text(fragment, encoding='utf-8')
    assert DESTINATION.read_text(encoding='utf-8') == fragment
    print(json.dumps({'path': str(DESTINATION), 'bytes': len(fragment.encode('utf-8')), 'portraits': portrait_count, 'sceneImages': scene_images, 'scripts': [str(path.relative_to(PROJECT)) for path in loaded]}, ensure_ascii=False))


if __name__ == '__main__':
    build()
