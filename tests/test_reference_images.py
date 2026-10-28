"""Local reference lifecycle and official upload contract, without provider calls."""
import base64
import json
from pathlib import Path
import struct
import tempfile
import time
from types import SimpleNamespace
import unittest
import zlib

from server.httpd import Handler
from server.media import MediaRegistry, MediaRequestError
from server.reference_images import ReferenceImageStore, image_type
from server.runtime import InputError, Runtime
from server.workspace import Workspace
from server.trash import TrashManager
from test_runtime import Catalog, Provider


def png():
    def chunk(kind, content):
        return struct.pack('>I', len(content)) + kind + content + struct.pack('>I', zlib.crc32(kind + content))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'\x00\xff\xff\xff')) + chunk(b'IEND', b'')


class ReferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = Runtime(self.temp.name, Catalog(), Provider())
        self.addCleanup(self.runtime.close)
        self.workspace = Workspace(self.runtime)
        self.workspace.save({'expectedRevision': 0, 'state': {'version': 3, 'projects': [{'id': 'p', 'kind': 'film'}, {'id': 'q', 'kind': 'film'}],
            'tasks': [], 'decisions': [], 'artifacts': [], 'messages': [], 'activity': [], 'favorites': []}})
        self.runtime.save('canvas', {'id': 'p', 'projectId': 'p', 'nodes': [{'id': 'n', 'mediaKind': 'image'}, {'id': 'n2', 'mediaKind': 'image'}]})
        self.calls = []
        def transport(url, body, headers, timeout):
            self.calls.append((url, body, headers))
            return {'code': 0, 'data': {'download_url': 'https://cdn.example.com/upload-' + str(len(self.calls)) + '.png', 'fileName': 'input/a.png'}}
        self.media = MediaRegistry(Path(self.temp.name) / 'config.json', transport)
        self.media.configure('runninghub', {'modelApiKey': 'fake-reference-key'})
        self.store = ReferenceImageStore(self.runtime, self.workspace, self.media)
        self.payload = {'nodeId': 'n', 'name': '我的造型.png', 'contentBase64': base64.b64encode(png()).decode()}

    def test_local_upload_dedup_preview_and_no_external_request(self):
        ref = self.store.add('p', self.payload)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.store.read('p', ref['id']), (png(), 'image/png'))
        self.assertEqual(self.store.add('p', self.payload)['id'], ref['id'])
        self.assertNotIn('remoteUrl', ref)
        self.assertNotIn('fake-reference-key', json.dumps(ref))
        self.assertTrue(ref['previewUrl'].startswith('/api/projects/p/reference-images/ref-'))
        self.assertEqual((self.store.directory / (ref['id'] + '.png')).stat().st_mode & 0o777, 0o600)

    def test_project_and_node_ownership_and_missing_nodes(self):
        ref = self.store.add('p', self.payload)
        for call in (lambda: self.store.validate('q', 'n', ref['id']), lambda: self.store.validate('p', 'n2', ref['id']),
                     lambda: self.store.add('p', {**self.payload, 'nodeId': 'missing'}), lambda: self.store.read('p', '../config')):
            with self.assertRaises(InputError): call()

    def test_invalid_file_data_and_raster_dimensions_rejected(self):
        for data in ['!!notbase64', base64.b64encode(b'<svg><script>alert(1)</script></svg>').decode(), base64.b64encode(b'\x89PNG\r\n\x1a\n').decode()]:
            with self.assertRaises(InputError): self.store.add('p', {**self.payload, 'contentBase64': data})
        bomb = bytearray(png());bomb[16:20] = (100000).to_bytes(4, 'big')
        with self.assertRaises(InputError): image_type(bytes(bomb))
        self.assertEqual(self.calls, [])

    def test_reselect_missing_original_recovers_with_new_reference(self):
        ref = self.store.add('p', self.payload)
        (self.store.directory / (ref['id'] + '.png')).unlink()
        replacement = self.store.add('p', self.payload)
        self.assertNotEqual(replacement['id'], ref['id'])
        self.assertEqual(self.store.read('p', replacement['id'])[0], png())

    def test_reference_originals_follow_node_recycle_restore_and_permanent_delete(self):
        ref = self.store.add('p', self.payload)
        trash = TrashManager(self.runtime, self.workspace)
        entries = trash.delete({'kind': 'canvas_node', 'targetId': 'n', 'projectId': 'p'})
        with self.assertRaises(InputError): self.store.read('p', ref['id'])
        trash.restore(entries[0]['id'])
        self.assertEqual(self.store.read('p', ref['id'])[0], png())
        entries = trash.delete({'kind': 'canvas_node', 'targetId': 'n', 'projectId': 'p'})
        trash.purge({'ids': [entries[0]['id']], 'confirmation': 'permanent-delete'})
        self.assertFalse((self.store.directory / (ref['id'] + '.png')).exists())
        self.assertEqual(self.runtime.all('reference_image'), [])

    def test_permanent_project_delete_cleans_reference_files(self):
        ref = self.store.add('p', self.payload)
        trash = TrashManager(self.runtime, self.workspace)
        entries = trash.delete({'kind': 'project', 'targetId': 'p', 'projectId': 'p'})
        trash.purge({'ids': [entries[0]['id']], 'confirmation': 'permanent-delete'})
        self.assertFalse((self.store.directory / (ref['id'] + '.png')).exists())
        self.assertEqual(self.runtime.all('reference_image'), [])

    def test_prepare_uses_official_binary_contract_reuses_cache_and_refreshes_expiry(self):
        ref = self.store.add('p', self.payload)
        with self.assertRaises(InputError): self.store.urls('p', 'n', [ref['id']])
        self.store.prepare('p', 'n', [ref['id']])
        url, body, headers = self.calls[0]
        self.assertEqual(url, 'https://www.runninghub.cn/openapi/v2/media/upload/binary')
        self.assertIn(b'name="file"', body);self.assertIn(png(), body)
        self.assertEqual(headers['Authorization'], 'Bearer fake-reference-key')
        self.assertTrue(headers['Content-Type'].startswith('multipart/form-data; boundary='))
        first = self.store.urls('p', 'n', [ref['id']]);self.store.prepare('p', 'n', [ref['id']])
        self.assertEqual(len(self.calls), 1)
        record = self.runtime.get('reference_image', ref['id']);record['remoteExpiresAt'] = time.time() - 1;self.runtime.save('reference_image', record)
        with self.assertRaises(InputError): self.store.urls('p', 'n', [ref['id']])
        self.assertEqual(len(self.calls), 1, 'reading an expired URL must not upload during generation validation')
        self.store.prepare('p', 'n', [ref['id']])
        self.assertNotEqual(self.store.urls('p', 'n', [ref['id']]), first)

    def test_failed_upload_keeps_original_and_hides_provider_diagnostics(self):
        ref = self.store.add('p', self.payload)
        self.media._transport = lambda *args: {'code': 401, 'message': 'fake-reference-key', 'data': {}}
        with self.assertRaises(MediaRequestError) as error: self.store.prepare('p', 'n', [ref['id']])
        self.assertNotIn('fake-reference-key', str(error.exception))
        self.assertEqual(self.store.read('p', ref['id'])[0], png())

    def test_http_routes_local_upload_and_inline_image_read(self):
        handler = object.__new__(Handler)
        handler.server = SimpleNamespace(runtime=self.runtime, media=self.media, canvas=SimpleNamespace(references=self.store))
        responses = [];handler.send = lambda *args: responses.append(args);handler.guard = lambda *args: None
        path = '/api/projects/p/reference-images'
        handler.post(path, path.strip('/').split('/'), self.payload)
        self.assertEqual(responses[-1][0], 201)
        ref = responses[-1][1]['reference'];handler.path = ref['previewUrl'];handler.handle_request(False)
        self.assertEqual(responses[-1][0:3], (200, png(), 'image/png'))
        self.assertEqual(responses[-1][3]['Content-Disposition'], 'inline')
        self.assertEqual(self.calls, [])


if __name__ == '__main__': unittest.main()
