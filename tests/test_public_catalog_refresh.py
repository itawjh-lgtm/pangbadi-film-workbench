"""Public catalog refresh never replaces working data with failed downloads."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'docs/api/runninghub/refresh_public_catalog.py'
SPEC = importlib.util.spec_from_file_location('rh_refresh', SCRIPT)
refresh = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(refresh)


class PublicCatalogRefreshTests(unittest.TestCase):
    def test_node_prompt_and_asset_defaults_are_removed(self):
        value = refresh.clean_schema({'type': 'object', 'properties': {
            '84##value': {'type': 'string', 'default': 'an unrelated example prompt'},
            'scriptContent': {'type': 'string', 'default': 'example narration'},
            'urls': {'type': 'array', 'default': ['https://example.com/sample.png']},
            'ratio': {'type': 'string', 'enum': ['16:9', '1:1'], 'default': '16:9'},
            'count': {'type': 'integer', 'default': 0},
            'audio': {'type': 'boolean', 'default': False}}})['properties']
        for name in ('84##value', 'scriptContent', 'urls'):
            self.assertNotIn('default', value[name])
        self.assertEqual(value['ratio']['default'], '16:9')
        self.assertEqual(value['count']['default'], 0)
        self.assertIs(value['audio']['default'], False)

    def test_failed_fetch_or_empty_catalog_does_not_replace_previous_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            current = root / 'public-model-catalog.json'
            current.write_text('previous-valid-snapshot')
            for payload in ({'errors': [{'docUrl': 'missing'}], 'models': []},
                            {'errors': [], 'models': []}):
                with self.assertRaises(ValueError):
                    refresh.save_snapshot(root, payload, [], '')
                self.assertEqual(current.read_text(), 'previous-valid-snapshot')

    def test_duplicate_or_unexpected_model_paths_are_rejected(self):
        row = {'method': 'POST', 'path': '/openapi/v2/example/text-to-image',
               'schema': {'type': 'object', 'properties': {'prompt': {'type': 'string'}}}}
        for rows in ([row, row], [{**row, 'method': 'GET'}],
                     [{**row, 'path': 'https://other.example/generate'}]):
            with self.assertRaises(ValueError):
                refresh.validate_snapshot({'errors': [], 'models': rows})

    def test_nonofficial_document_url_is_rejected_before_transport(self):
        for url in ('http://www.runninghub.cn/runninghub-api-doc-cn/a.md',
                    'https://other.example/runninghub-api-doc-cn/a.md',
                    'https://www.runninghub.cn/call-api/bill-task'):
            with self.assertRaises(ValueError):
                refresh.get(url)


if __name__ == '__main__':
    unittest.main()
