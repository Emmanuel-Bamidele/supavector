import io
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock
from urllib import parse as urllib_parse
from urllib import error as urllib_error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from supavector import Client, SupaVectorError


class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status = status

    def read(self):
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class ClientTests(unittest.TestCase):
    def test_build_query_includes_defaults_and_array_values(self):
        client = Client(
            base_url="http://localhost:3000/",
            tenant_id="tenant-1",
            collection="default",
        )
        query = client.build_query({
            "q": "memory",
            "types": ["semantic", "summary"],
            "favorRecency": True,
        })
        self.assertEqual(
            query,
            "?q=memory&types=semantic%2Csummary&favorRecency=true&tenantId=tenant-1&collection=default",
        )

    def test_build_body_includes_defaults(self):
        client = Client(
            tenant_id="tenant-1",
            collection="default",
            principal_id="svc:agent-api",
        )
        body = client.build_body({"question": "What changed?"})
        self.assertEqual(body["tenantId"], "tenant-1")
        self.assertEqual(body["collection"], "default")
        self.assertEqual(body["principalId"], "svc:agent-api")
        self.assertEqual(body["question"], "What changed?")

    @mock.patch("supavector.client.urllib_request.urlopen")
    def test_request_prefers_api_key_and_sends_provider_headers(self, urlopen):
        urlopen.return_value = FakeResponse({"ok": True, "data": {"answer": "ok"}})
        client = Client(
            base_url="http://localhost:3000",
            token="jwt-token",
            api_key="service-token",
            openai_api_key="openai-key",
            gemini_api_key="gemini-key",
            anthropic_api_key="anthropic-key",
            collection="default",
        )
        payload = client.ask("What does SupaVector store?", {"k": 7})
        self.assertEqual(payload["data"]["answer"], "ok")
        req = urlopen.call_args.args[0]
        self.assertEqual(req.full_url, "http://localhost:3000/v1/ask")
        self.assertEqual(req.headers["X-api-key"], "service-token")
        self.assertNotIn("Authorization", req.headers)
        self.assertEqual(req.headers["X-openai-api-key"], "openai-key")
        self.assertEqual(req.headers["X-gemini-api-key"], "gemini-key")
        self.assertEqual(req.headers["X-anthropic-api-key"], "anthropic-key")
        self.assertEqual(json.loads(req.data.decode("utf-8")), {
            "question": "What does SupaVector store?",
            "k": 7,
            "collection": "default",
        })

    @mock.patch("supavector.client.urllib_request.urlopen")
    def test_write_endpoints_promote_idempotency_header(self, urlopen):
        urlopen.return_value = FakeResponse({"ok": True})
        client = Client(base_url="http://localhost:3000")
        client.memory_write({
            "text": "Remember this.",
            "type": "semantic",
            "idempotencyKey": "mem-001",
        })
        req = urlopen.call_args.args[0]
        self.assertEqual(req.headers["Idempotency-key"], "mem-001")
        self.assertEqual(json.loads(req.data.decode("utf-8")), {
            "text": "Remember this.",
            "type": "semantic",
        })

    @mock.patch("supavector.client.urllib_request.urlopen")
    def test_vector_admin_helpers_call_expected_routes(self, urlopen):
        urlopen.return_value = FakeResponse({"ok": True, "data": {"accepted": True}})
        client = Client(base_url="http://localhost:3000", api_key="service-token")

        client.vector_runtime()
        runtime_req = urlopen.call_args.args[0]
        self.assertEqual(runtime_req.get_method(), "GET")
        self.assertEqual(runtime_req.full_url, "http://localhost:3000/v1/admin/vector/search-runtime")
        self.assertEqual(runtime_req.headers["X-api-key"], "service-token")

        client.vector_reindex({"mode": "always"})
        reindex_req = urlopen.call_args.args[0]
        self.assertEqual(reindex_req.get_method(), "POST")
        self.assertEqual(reindex_req.full_url, "http://localhost:3000/v1/admin/vector/reindex")
        self.assertEqual(json.loads(reindex_req.data.decode("utf-8")), {"mode": "always"})

    @mock.patch("supavector.client.urllib_request.urlopen")
    def test_http_errors_raise_sdk_error_with_payload(self, urlopen):
        error_body = {
            "error": {
                "message": "Unauthorized",
            }
        }
        urlopen.side_effect = urllib_error.HTTPError(
            url="http://localhost:3000/v1/docs",
            code=401,
            msg="Unauthorized",
            hdrs=None,
            fp=io.BytesIO(json.dumps(error_body).encode("utf-8")),
        )
        client = Client(base_url="http://localhost:3000")
        with self.assertRaises(SupaVectorError) as ctx:
            client.list_docs()
        self.assertEqual(str(ctx.exception), "Unauthorized")
        self.assertEqual(ctx.exception.status, 401)
        self.assertEqual(ctx.exception.payload, error_body)

    def test_from_env_reads_standard_variables(self):
        env = {
            "SUPAVECTOR_BASE_URL": "http://localhost:3000",
            "SUPAVECTOR_API_KEY": "service-token",
            "OPENAI_API_KEY": "openai-key",
            "GEMINI_API_KEY": "gemini-key",
            "ANTHROPIC_API_KEY": "anthropic-key",
            "SUPAVECTOR_COLLECTION": "default",
            "SUPAVECTOR_TENANT_ID": "tenant-1",
            "SUPAVECTOR_PRINCIPAL_ID": "svc:agent-api",
        }
        with mock.patch.dict(os.environ, env, clear=True):
            client = Client.from_env()
        self.assertEqual(client.base_url, "http://localhost:3000")
        self.assertEqual(client.api_key, "service-token")
        self.assertEqual(client.openai_api_key, "openai-key")
        self.assertEqual(client.gemini_api_key, "gemini-key")
        self.assertEqual(client.anthropic_api_key, "anthropic-key")
        self.assertEqual(client.collection, "default")
        self.assertEqual(client.tenant_id, "tenant-1")
        self.assertEqual(client.principal_id, "svc:agent-api")

    @mock.patch("supavector.client.urllib_request.urlopen")
    def test_stateful_transport_login_search_and_ask_flow(self, urlopen):
        calls = []

        def fake_urlopen(req, timeout=None):
            calls.append({
                "method": req.get_method(),
                "url": req.full_url,
                "headers": dict(req.headers),
                "body": req.data.decode("utf-8") if req.data else "",
                "timeout": timeout,
            })
            parsed = urllib_parse.urlparse(req.full_url)
            route = (req.get_method(), parsed.path)
            if route == ("POST", "/v1/login"):
                return FakeResponse({
                    "ok": True,
                    "data": {
                        "token": "jwt-123",
                        "user": {
                            "tenant": "tenant-1",
                        },
                    },
                })
            if route == ("GET", "/v1/search"):
                return FakeResponse({
                    "ok": True,
                    "data": {
                        "results": [],
                    },
                })
            if route == ("POST", "/v1/ask"):
                return FakeResponse({
                    "ok": True,
                    "data": {
                        "answer": "SupaVector stores memory for agents.",
                    },
                })
            raise AssertionError(f"Unexpected request {route}")

        urlopen.side_effect = fake_urlopen
        client = Client(base_url="http://localhost:3000", collection="default")

        login = client.login("admin", "change_me")
        self.assertEqual(login["data"]["token"], "jwt-123")
        self.assertEqual(client.token, "jwt-123")
        self.assertEqual(client.tenant_id, "tenant-1")

        search = client.search("memory", {"k": 5, "favorRecency": True})
        self.assertEqual(search["data"]["results"], [])

        answer = client.ask("What does SupaVector store?", {"k": 7})
        self.assertEqual(answer["data"]["answer"], "SupaVector stores memory for agents.")

        self.assertEqual(len(calls), 3)

        login_call = calls[0]
        self.assertEqual(login_call["method"], "POST")
        self.assertEqual(login_call["url"], "http://localhost:3000/v1/login")
        self.assertEqual(
            json.loads(login_call["body"]),
            {
                "username": "admin",
                "password": "change_me",
                "collection": "default",
            },
        )

        search_call = calls[1]
        parsed_search = urllib_parse.urlparse(search_call["url"])
        self.assertEqual(parsed_search.path, "/v1/search")
        self.assertEqual(search_call["headers"]["Authorization"], "Bearer jwt-123")
        self.assertEqual(
            urllib_parse.parse_qs(parsed_search.query),
            {
                "q": ["memory"],
                "k": ["5"],
                "favorRecency": ["true"],
                "tenantId": ["tenant-1"],
                "collection": ["default"],
            },
        )

        ask_call = calls[2]
        self.assertEqual(ask_call["url"], "http://localhost:3000/v1/ask")
        self.assertEqual(ask_call["headers"]["Authorization"], "Bearer jwt-123")
        self.assertEqual(
            json.loads(ask_call["body"]),
            {
                "question": "What does SupaVector store?",
                "k": 7,
                "tenantId": "tenant-1",
                "collection": "default",
            },
        )

    @mock.patch("supavector.client.urllib_request.urlopen")
    def test_index_file_sets_code_metadata_and_doc_id_from_relative_path(self, urlopen):
        urlopen.return_value = FakeResponse({"ok": True, "data": {"chunksIndexed": 1}})
        client = Client(base_url="http://localhost:3000", api_key="service-token")

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            file_path = root / "src" / "refunds.ts"
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text("export function refundWindowDays() { return 30; }\n", encoding="utf-8")

            payload = client.index_file(str(file_path), params={"collection": "support-docs"}, base_dir=str(root))
            self.assertTrue(payload["ok"])

            req = urlopen.call_args.args[0]
            self.assertEqual(req.full_url, "http://localhost:3000/v1/docs")
            self.assertEqual(req.headers["X-api-key"], "service-token")
            body = json.loads(req.data.decode("utf-8"))
            self.assertEqual(body["docId"], "src__refunds.ts")
            self.assertEqual(body["collection"], "support-docs")
            self.assertEqual(body["title"], "src/refunds.ts")
            self.assertEqual(body["sourceType"], "code")
            self.assertEqual(body["metadata"]["path"], "src/refunds.ts")
            self.assertEqual(body["metadata"]["language"], "typescript")
            self.assertIn("refundWindowDays", body["text"])

    @mock.patch("supavector.client.urllib_request.urlopen")
    def test_index_file_extracts_docx_text(self, urlopen):
        urlopen.return_value = FakeResponse({"ok": True, "data": {"chunksIndexed": 1}})
        client = Client(base_url="http://localhost:3000")

        with tempfile.TemporaryDirectory() as temp_dir:
            file_path = Path(temp_dir) / "notes.docx"
            with zipfile.ZipFile(file_path, "w") as archive:
                archive.writestr(
                    "word/document.xml",
                    """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                      <w:body>
                        <w:p><w:r><w:t>Hello</w:t></w:r></w:p>
                        <w:p><w:r><w:t>From Docx</w:t></w:r></w:p>
                      </w:body>
                    </w:document>""",
                )

            client.index_file(str(file_path), doc_id="notes_docx", params={"collection": "docs"})
            req = urlopen.call_args.args[0]
            body = json.loads(req.data.decode("utf-8"))
            self.assertEqual(body["docId"], "notes_docx")
            self.assertEqual(body["title"], "notes.docx")
            self.assertEqual(body["metadata"]["path"], "notes.docx")
            self.assertEqual(body["text"], "Hello\n\nFrom Docx")

    @mock.patch("supavector.client.urllib_request.urlopen")
    def test_index_folder_defaults_collection_and_skips_noise(self, urlopen):
        captured_requests = []

        def fake_urlopen(req, timeout=None):
            body = json.loads(req.data.decode("utf-8"))
            captured_requests.append({
                "docId": body["docId"],
                "collection": body["collection"],
                "path": body["metadata"]["path"],
                "idempotency": req.headers.get("Idempotency-key"),
            })
            return FakeResponse({"ok": True, "data": {"docId": body["docId"]}})

        urlopen.side_effect = fake_urlopen
        client = Client(base_url="http://localhost:3000")

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "customer-support"
            (root / "src").mkdir(parents=True, exist_ok=True)
            (root / "node_modules").mkdir(parents=True, exist_ok=True)
            (root / ".hidden").mkdir(parents=True, exist_ok=True)
            (root / "README.md").write_text("# Support\n", encoding="utf-8")
            (root / "src" / "handler.py").write_text("def handler():\n    return 'ok'\n", encoding="utf-8")
            (root / "node_modules" / "ignored.js").write_text("console.log('skip')\n", encoding="utf-8")
            (root / ".hidden" / "secret.txt").write_text("skip\n", encoding="utf-8")
            (root / "image.png").write_bytes(b"\x89PNG\r\n")

            result = client.index_folder(str(root))

            self.assertEqual(result["collection"], "customer-support")
            self.assertEqual(result["indexedCount"], 2)
            self.assertEqual(result["errorCount"], 0)
            self.assertEqual(
                [
                    (item["docId"], item["collection"], item["path"])
                    for item in captured_requests
                ],
                [
                    ("README.md", "customer-support", "README.md"),
                    ("src__handler.py", "customer-support", "src/handler.py"),
                ],
            )

    @mock.patch("supavector.client.urllib_request.urlopen")
    def test_index_folder_derives_per_file_idempotency_keys(self, urlopen):
        idempotency_keys = []

        def fake_urlopen(req, timeout=None):
            idempotency_keys.append(req.headers.get("Idempotency-key"))
            return FakeResponse({"ok": True, "data": {"docId": "ok"}})

        urlopen.side_effect = fake_urlopen
        client = Client(base_url="http://localhost:3000")

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "batch"
            root.mkdir(parents=True, exist_ok=True)
            (root / "a.txt").write_text("alpha\n", encoding="utf-8")
            (root / "b.txt").write_text("beta\n", encoding="utf-8")

            result = client.index_folder(str(root), params={"idempotencyKey": "batch-001"})

            self.assertEqual(result["indexedCount"], 2)
            self.assertEqual(
                idempotency_keys,
                ["batch-001:a.txt", "batch-001:b.txt"],
            )

    def test_index_file_rejects_unsupported_extension(self):
        client = Client(base_url="http://localhost:3000")
        with tempfile.TemporaryDirectory() as temp_dir:
            file_path = Path(temp_dir) / "archive.bin"
            file_path.write_bytes(b"\x00\x01\x02")
            with self.assertRaises(SupaVectorError) as ctx:
                client.index_file(str(file_path))
        self.assertIn("Unsupported file type", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
