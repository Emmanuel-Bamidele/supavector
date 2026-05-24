from __future__ import annotations

import importlib
import json
import os
import random
import re
import string
import zipfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Dict, Optional
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request
from xml.etree import ElementTree


class SupaVectorError(Exception):
    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        payload: Any = None,
        response_body: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.payload = payload
        self.response_body = response_body


def _normalize_base_url(value: Optional[str]) -> str:
    base_url = (value or "http://localhost:3000").rstrip("/")
    return base_url or "http://localhost:3000"


def _stringify_query_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


INGESTIBLE_TEXT_EXTENSIONS = {
    ".txt",
    ".md",
    ".markdown",
    ".json",
    ".csv",
    ".log",
    ".yaml",
    ".yml",
    ".xml",
    ".ini",
    ".cfg",
    ".conf",
    ".toml",
    ".sql",
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".py",
    ".rb",
    ".go",
    ".rs",
    ".java",
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
    ".sh",
    ".bash",
    ".zsh",
}

CODEBASE_SKIP_DIR_NAMES = {
    ".git",
    ".hg",
    ".svn",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".pnpm-store",
    ".yarn",
    ".gradle",
    ".idea",
    ".vscode",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "out",
    "target",
    "vendor",
    "Pods",
    "DerivedData",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".serverless",
    ".aws-sam",
}

CODE_LANGUAGE_BY_BASENAME = {
    "dockerfile": "docker",
    "makefile": "makefile",
    "jenkinsfile": "groovy",
    "procfile": "procfile",
    "gemfile": "ruby",
    "rakefile": "ruby",
    "podfile": "ruby",
    "brewfile": "ruby",
    "package.json": "json",
    "package-lock.json": "json",
    "pnpm-lock.yaml": "yaml",
    "yarn.lock": "yaml",
    "tsconfig.json": "json",
    "jsconfig.json": "json",
    "pyproject.toml": "toml",
    "requirements.txt": "text",
    "pipfile": "toml",
    "cargo.toml": "toml",
    "cargo.lock": "toml",
    "go.mod": "go",
    "go.sum": "go",
    "pom.xml": "xml",
    "build.gradle": "groovy",
    "build.gradle.kts": "kotlin",
    "settings.gradle": "groovy",
    "settings.gradle.kts": "kotlin",
    "gradle.properties": "properties",
    "composer.json": "json",
    "composer.lock": "json",
    "mix.exs": "elixir",
    "mix.lock": "elixir",
}

CODE_LANGUAGE_BY_EXTENSION = {
    ".c": "c",
    ".cc": "cpp",
    ".conf": "conf",
    ".cpp": "cpp",
    ".cs": "csharp",
    ".css": "css",
    ".cxx": "cpp",
    ".go": "go",
    ".gradle": "groovy",
    ".groovy": "groovy",
    ".h": "c",
    ".hh": "cpp",
    ".hpp": "cpp",
    ".htm": "html",
    ".html": "html",
    ".ini": "ini",
    ".java": "java",
    ".js": "javascript",
    ".json": "json",
    ".jsx": "jsx",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".less": "less",
    ".mjs": "javascript",
    ".mdx": "mdx",
    ".php": "php",
    ".ps1": "powershell",
    ".py": "python",
    ".rb": "ruby",
    ".rs": "rust",
    ".sass": "sass",
    ".scala": "scala",
    ".scss": "scss",
    ".sh": "shell",
    ".sql": "sql",
    ".svelte": "svelte",
    ".swift": "swift",
    ".toml": "toml",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".vue": "vue",
    ".xml": "xml",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".zsh": "shell",
}


def _random_secret(length: int = 6) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(max(1, int(length))))


def _default_collection_from_folder(folder_path: str) -> str:
    return Path(str(folder_path or "").strip()).resolve().name


def _detect_ingestible_file_type(file_path: Path) -> str:
    ext = file_path.suffix.lower()
    if ext in INGESTIBLE_TEXT_EXTENSIONS:
        return "text"
    if ext == ".pdf":
        return "pdf"
    if ext == ".docx":
        return "docx"
    return "unsupported"


def _detect_code_language(file_path: str) -> Optional[str]:
    text = str(file_path or "").strip()
    if not text:
        return None
    base = Path(text).name.lower()
    if base in CODE_LANGUAGE_BY_BASENAME:
        return CODE_LANGUAGE_BY_BASENAME[base]
    return CODE_LANGUAGE_BY_EXTENSION.get(Path(base).suffix.lower())


def _should_skip_codebase_rel_path(relative_path: str) -> bool:
    clean = str(relative_path or "").strip()
    if not clean:
        return False
    segments = [segment for segment in re.split(r"[\\/]+", clean) if segment]
    return any(segment in CODEBASE_SKIP_DIR_NAMES for segment in segments)


def _is_probably_text_buffer(raw: bytes) -> bool:
    if not raw:
        return True
    sample = raw[: min(len(raw), 2048)]
    weird = 0
    for byte in sample:
        if byte == 0:
            return False
        if byte < 7 or (14 < byte < 32):
            weird += 1
    return weird / len(sample) < 0.15


def _normalize_extracted_text(value: Any) -> str:
    return (
        str(value or "")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\t", " ")
        .replace(" \n", "\n")
        .replace("\n\n\n", "\n\n")
        .strip()
    )


def _extract_docx_text(file_path: Path) -> str:
    try:
        with zipfile.ZipFile(file_path) as archive:
            xml = archive.read("word/document.xml")
    except KeyError as exc:
        raise SupaVectorError(f"Failed to extract DOCX text from {file_path.name}: word/document.xml missing") from exc
    except zipfile.BadZipFile as exc:
        raise SupaVectorError(f"Failed to extract DOCX text from {file_path.name}: invalid DOCX archive") from exc

    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError as exc:
        raise SupaVectorError(f"Failed to extract DOCX text from {file_path.name}: invalid XML") from exc

    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    paragraphs = []
    for paragraph in root.findall(".//w:p", namespace):
        parts = []
        for node in paragraph.iter():
            tag = node.tag.rsplit("}", 1)[-1] if "}" in node.tag else node.tag
            if tag == "t" and node.text:
                parts.append(node.text)
            elif tag == "tab":
                parts.append("\t")
            elif tag in {"br", "cr"}:
                parts.append("\n")
        line = "".join(parts).strip()
        if line:
            paragraphs.append(line)
    return _normalize_extracted_text("\n\n".join(paragraphs))


def _extract_pdf_text(file_path: Path) -> str:
    try:
        pypdf = importlib.import_module("pypdf")
    except ModuleNotFoundError as exc:
        raise SupaVectorError(
            f'PDF ingest for {file_path.name} requires the optional "pypdf" dependency. '
            'Install it with `python3 -m pip install ".[pdf]"` from sdk/python or add `pypdf` to your environment.'
        ) from exc
    try:
        reader = pypdf.PdfReader(str(file_path))
        text = "\n\n".join(page.extract_text() or "" for page in reader.pages)
    except Exception as exc:  # pragma: no cover - parser-specific failures
        raise SupaVectorError(f"Failed to extract PDF text from {file_path.name}: {exc}") from exc
    return _normalize_extracted_text(text)


def _extract_document_text(file_path: Path) -> str:
    file_type = _detect_ingestible_file_type(file_path)
    if file_type == "unsupported":
        raise SupaVectorError(f"Unsupported file type: {file_path.suffix or '(no extension)'}")

    raw = file_path.read_bytes()
    if file_type == "text":
        if not _is_probably_text_buffer(raw):
            raise SupaVectorError(f"Binary or non-text content is not supported for {file_path.name}")
        return raw.decode("utf-8")
    if file_type == "pdf":
        return _extract_pdf_text(file_path)
    return _extract_docx_text(file_path)


def _safe_doc_id_from_path(relative_path: str) -> str:
    text = str(relative_path or "").strip()
    normalized = (
        "__".join(part for part in re.split(r"[\\/]+", text) if part)
        .replace(" ", "-")
    )
    normalized = re.sub(r"[^A-Za-z0-9._-]", "-", normalized)
    normalized = re.sub(r"-+", "-", normalized)
    normalized = re.sub(r"^[-.]+|[-.]+$", "", normalized)
    return normalized or f"doc-{_random_secret(6)}"


def _derive_folder_idempotency_key(prefix: str, doc_id: str) -> str:
    clean_prefix = str(prefix or "").strip()
    clean_doc_id = str(doc_id or "").strip() or _random_secret(6)
    return f"{clean_prefix}:{clean_doc_id}" if clean_prefix else clean_doc_id


class SupaVectorClient:
    def __init__(
        self,
        *,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        api_key: Optional[str] = None,
        openai_api_key: Optional[str] = None,
        gemini_api_key: Optional[str] = None,
        anthropic_api_key: Optional[str] = None,
        tenant_id: Optional[str] = None,
        collection: Optional[str] = None,
        principal_id: Optional[str] = None,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = _normalize_base_url(base_url)
        self.token = token or None
        self.api_key = api_key or None
        self.openai_api_key = openai_api_key or None
        self.gemini_api_key = gemini_api_key or None
        self.anthropic_api_key = anthropic_api_key or None
        self.tenant_id = tenant_id or None
        self.collection = collection or None
        self.principal_id = principal_id or None
        self.timeout = float(timeout)

    @classmethod
    def from_env(cls, **overrides: Any) -> "SupaVectorClient":
        options = {
            "base_url": os.getenv("SUPAVECTOR_BASE_URL") or os.getenv("SUPAVECTOR_URL") or "http://localhost:3000",
            "api_key": os.getenv("SUPAVECTOR_API_KEY"),
            "openai_api_key": os.getenv("OPENAI_API_KEY"),
            "gemini_api_key": os.getenv("GEMINI_API_KEY") or os.getenv("GEMINI_API"),
            "anthropic_api_key": os.getenv("ANTHROPIC_API_KEY"),
            "collection": os.getenv("SUPAVECTOR_COLLECTION"),
            "tenant_id": os.getenv("SUPAVECTOR_TENANT_ID"),
            "principal_id": os.getenv("SUPAVECTOR_PRINCIPAL_ID"),
        }
        options.update(overrides)
        return cls(**options)

    def set_token(self, token: Optional[str]) -> None:
        self.token = token or None

    def set_api_key(self, api_key: Optional[str]) -> None:
        self.api_key = api_key or None

    def set_openai_api_key(self, openai_api_key: Optional[str]) -> None:
        self.openai_api_key = openai_api_key or None

    def set_gemini_api_key(self, gemini_api_key: Optional[str]) -> None:
        self.gemini_api_key = gemini_api_key or None

    def set_anthropic_api_key(self, anthropic_api_key: Optional[str]) -> None:
        self.anthropic_api_key = anthropic_api_key or None

    def set_provider_api_key(self, provider: Optional[str], value: Optional[str]) -> None:
        clean_provider = str(provider or "").strip().lower()
        if clean_provider == "gemini":
            self.gemini_api_key = value or None
            return
        if clean_provider == "anthropic":
            self.anthropic_api_key = value or None
            return
        self.openai_api_key = value or None

    def set_tenant(self, tenant_id: Optional[str]) -> None:
        self.tenant_id = tenant_id or None

    def set_collection(self, collection: Optional[str]) -> None:
        self.collection = collection or None

    def set_principal(self, principal_id: Optional[str]) -> None:
        self.principal_id = principal_id or None

    def build_query(self, params: Optional[Mapping[str, Any]] = None) -> str:
        query: Dict[str, Any] = dict(params or {})
        if self.tenant_id and query.get("tenantId") is None:
            query["tenantId"] = self.tenant_id
        if self.collection and query.get("collection") is None:
            query["collection"] = self.collection
        encoded: Dict[str, str] = {}
        for key, value in query.items():
            if value is None or value == "":
                continue
            if isinstance(value, (list, tuple)):
                encoded[key] = ",".join(_stringify_query_value(item) for item in value)
            else:
                encoded[key] = _stringify_query_value(value)
        if not encoded:
            return ""
        return f"?{urllib_parse.urlencode(encoded)}"

    def build_body(self, body: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        payload: Dict[str, Any] = dict(body or {})
        if self.tenant_id and payload.get("tenantId") is None:
            payload["tenantId"] = self.tenant_id
        if self.collection and payload.get("collection") is None:
            payload["collection"] = self.collection
        if self.principal_id and payload.get("principalId") is None:
            payload["principalId"] = self.principal_id
        return payload

    def _build_headers(
        self,
        *,
        auth: bool = True,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if auth:
            if self.api_key:
                headers["X-API-Key"] = self.api_key
            elif self.token:
                headers["Authorization"] = f"Bearer {self.token}"
        if self.openai_api_key:
            headers["X-OpenAI-API-Key"] = self.openai_api_key
        if self.gemini_api_key:
            headers["X-Gemini-API-Key"] = self.gemini_api_key
        if self.anthropic_api_key:
            headers["X-Anthropic-API-Key"] = self.anthropic_api_key
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

    def _decode_json(self, payload: bytes) -> Any:
        text = payload.decode("utf-8") if payload else ""
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise SupaVectorError(
                "Response was not valid JSON",
                response_body=text,
            ) from exc

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        auth: bool = True,
        query: Optional[Mapping[str, Any]] = None,
        body: Optional[Mapping[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        query_string = self.build_query(query) if query is not None else ""
        url = f"{self.base_url}{path}{query_string}"
        body_bytes = None
        if body is not None:
            body_bytes = json.dumps(self.build_body(body)).encode("utf-8")
        req = urllib_request.Request(
            url,
            data=body_bytes,
            method=method.upper(),
            headers=self._build_headers(auth=auth, idempotency_key=idempotency_key),
        )
        try:
            with urllib_request.urlopen(req, timeout=self.timeout) as res:
                return self._decode_json(res.read())
        except urllib_error.HTTPError as exc:
            raw = exc.read()
            text = raw.decode("utf-8") if raw else ""
            payload = None
            if text:
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError:
                    payload = None
            message = (
                (payload or {}).get("error", {}).get("message")
                if isinstance((payload or {}).get("error"), Mapping)
                else (payload or {}).get("error")
            ) or exc.reason
            raise SupaVectorError(
                str(message),
                status=exc.code,
                payload=payload,
                response_body=text or None,
            ) from None
        except urllib_error.URLError as exc:
            raise SupaVectorError(f"Request failed: {exc.reason}") from None

    def health(self) -> Any:
        return self.request("/v1/health", auth=False)

    def login(self, username: str, password: str) -> Any:
        payload = self.request(
            "/v1/login",
            method="POST",
            auth=False,
            body={"username": username, "password": password},
        )
        if isinstance(payload, Mapping):
            data = payload.get("data") or {}
            token = data.get("token")
            if token:
                self.token = str(token)
            tenant = (data.get("user") or {}).get("tenant")
            if tenant:
                self.tenant_id = str(tenant)
        return payload

    def stats(self) -> Any:
        return self.request("/v1/stats")

    def vector_runtime(self) -> Any:
        return self.request("/v1/admin/vector/search-runtime")

    def vector_reindex(self, params: Optional[Mapping[str, Any]] = None) -> Any:
        return self.request("/v1/admin/vector/reindex", method="POST", body=dict(params or {}))

    def get_models(self) -> Any:
        return self.request("/v1/models", auth=False)

    def models(self) -> Any:
        return self.get_models()

    def list_docs(self, params: Optional[Mapping[str, Any]] = None) -> Any:
        return self.request("/v1/docs", query=params)

    def list_collections(self, params: Optional[Mapping[str, Any]] = None) -> Any:
        return self.request("/v1/collections", query=params)

    def index_text(self, doc_id: str, text: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        payload = dict(params or {})
        idempotency_key = payload.pop("idempotencyKey", None)
        return self.request(
            "/v1/docs",
            method="POST",
            body={"docId": doc_id, "text": text, **payload},
            idempotency_key=idempotency_key,
        )

    def index_url(self, doc_id: str, url: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        payload = dict(params or {})
        idempotency_key = payload.pop("idempotencyKey", None)
        return self.request(
            "/v1/docs/url",
            method="POST",
            body={"docId": doc_id, "url": url, **payload},
            idempotency_key=idempotency_key,
        )

    def _prepare_file_index(
        self,
        file_path: str,
        doc_id: Optional[str] = None,
        params: Optional[Mapping[str, Any]] = None,
        *,
        base_dir: Optional[str] = None,
    ) -> tuple[str, str, Dict[str, Any]]:
        abs_path = Path(str(file_path or "").strip()).expanduser().resolve()
        if not abs_path.is_file():
            raise SupaVectorError(f"File not found: {abs_path}")

        root = Path(str(base_dir or abs_path.parent)).expanduser().resolve()
        try:
            relative_path = abs_path.relative_to(root).as_posix()
        except ValueError:
            relative_path = abs_path.name

        text = _extract_document_text(abs_path)
        if not text.strip():
            raise SupaVectorError(f"No indexable text was extracted from {abs_path.name}")

        payload = dict(params or {})
        metadata = dict(payload.pop("metadata", {}) or {})
        file_doc_id = str(doc_id or payload.pop("docId", "")).strip() or _safe_doc_id_from_path(relative_path)
        if "title" not in payload or payload.get("title") in {None, ""}:
            payload["title"] = relative_path
        if "path" not in metadata and relative_path:
            metadata["path"] = relative_path
        language = _detect_code_language(relative_path)
        if language and "language" not in metadata and "lang" not in metadata:
            metadata["language"] = language
        if metadata:
            payload["metadata"] = metadata
        if language and ("sourceType" not in payload and "source_type" not in payload):
            payload["sourceType"] = "code"
        return file_doc_id, text, payload

    def index_file(
        self,
        file_path: str,
        doc_id: Optional[str] = None,
        params: Optional[Mapping[str, Any]] = None,
        *,
        base_dir: Optional[str] = None,
    ) -> Any:
        file_doc_id, text, payload = self._prepare_file_index(
            file_path,
            doc_id=doc_id,
            params=params,
            base_dir=base_dir,
        )
        return self.index_text(file_doc_id, text, payload)

    def index_folder(
        self,
        folder_path: str,
        params: Optional[Mapping[str, Any]] = None,
        *,
        recursive: bool = True,
        include_hidden: bool = False,
        continue_on_error: bool = True,
    ) -> Dict[str, Any]:
        root = Path(str(folder_path or "").strip()).expanduser().resolve()
        if not root.is_dir():
            raise SupaVectorError(f"Folder not found: {root}")

        base_payload = dict(params or {})
        resolved_collection = (
            base_payload.get("collection")
            or self.collection
            or _default_collection_from_folder(str(root))
        )
        base_payload["collection"] = resolved_collection
        batch_idempotency_prefix = str(base_payload.pop("idempotencyKey", "")).strip() or None

        indexed = []
        errors = []

        iterator = root.rglob("*") if recursive else root.glob("*")
        for candidate in sorted(iterator):
            if not candidate.is_file():
                continue
            relative_path = candidate.relative_to(root).as_posix()
            parts = relative_path.split("/")
            if not include_hidden and any(part.startswith(".") for part in parts):
                continue
            if _should_skip_codebase_rel_path(relative_path):
                continue
            if _detect_ingestible_file_type(candidate) == "unsupported":
                continue
            try:
                file_doc_id, text, payload = self._prepare_file_index(
                    str(candidate),
                    params=base_payload,
                    base_dir=str(root),
                )
                if batch_idempotency_prefix:
                    payload["idempotencyKey"] = _derive_folder_idempotency_key(batch_idempotency_prefix, file_doc_id)
                response = self.index_text(file_doc_id, text, payload)
                indexed.append({
                    "path": relative_path,
                    "docId": file_doc_id,
                    "response": response,
                })
            except Exception as exc:
                errors.append({
                    "path": relative_path,
                    "error": str(exc),
                })
                if not continue_on_error:
                    raise

        return {
            "folder": str(root),
            "collection": resolved_collection,
            "indexedCount": len(indexed),
            "errorCount": len(errors),
            "indexed": indexed,
            "errors": errors,
        }

    def delete_doc(self, doc_id: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        safe_doc_id = urllib_parse.quote(str(doc_id), safe="")
        return self.request(f"/v1/docs/{safe_doc_id}", method="DELETE", query=params)

    def delete_collection(self, collection: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        safe_collection = urllib_parse.quote(str(collection), safe="")
        return self.request(f"/v1/collections/{safe_collection}", method="DELETE", query=params)

    def search(self, query: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        next_query = {"q": query, **dict(params or {})}
        return self.request("/v1/search", query=next_query)

    def ask(self, question: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        return self.request("/v1/ask", method="POST", body={"question": question, **dict(params or {})})

    def code(self, question: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        return self.request("/v1/code", method="POST", body={"question": question, **dict(params or {})})

    def boolean_ask(self, question: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        return self.request("/v1/boolean_ask", method="POST", body={"question": question, **dict(params or {})})

    def memory_write(self, data: Optional[Mapping[str, Any]]) -> Any:
        payload = dict(data or {})
        idempotency_key = payload.pop("idempotencyKey", None)
        return self.request(
            "/v1/memory/write",
            method="POST",
            body=payload,
            idempotency_key=idempotency_key,
        )

    def memory_recall(self, data: Optional[Mapping[str, Any]]) -> Any:
        return self.request("/v1/memory/recall", method="POST", body=dict(data or {}))

    def memory_reflect(self, data: Optional[Mapping[str, Any]]) -> Any:
        payload = dict(data or {})
        idempotency_key = payload.pop("idempotencyKey", None)
        return self.request(
            "/v1/memory/reflect",
            method="POST",
            body=payload,
            idempotency_key=idempotency_key,
        )

    def memory_cleanup(self, data: Optional[Mapping[str, Any]]) -> Any:
        return self.request("/v1/memory/cleanup", method="POST", body=dict(data or {}))

    def memory_compact(self, data: Optional[Mapping[str, Any]]) -> Any:
        return self.request("/v1/memory/compact", method="POST", body=dict(data or {}))

    def feedback(self, data: Optional[Mapping[str, Any]]) -> Any:
        return self.request("/v1/feedback", method="POST", body=dict(data or {}))

    def get_tenant_settings(self) -> Any:
        return self.request("/v1/admin/tenant")

    def update_tenant_settings(self, data: Optional[Mapping[str, Any]]) -> Any:
        return self.request("/v1/admin/tenant", method="PATCH", body=dict(data or {}))

    def get_job(self, job_id: str) -> Any:
        safe_job_id = urllib_parse.quote(str(job_id), safe="")
        return self.request(f"/v1/jobs/{safe_job_id}")


Client = SupaVectorClient
