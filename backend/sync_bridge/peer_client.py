import hashlib
import hmac
import json
import secrets
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from django.conf import settings
from .services import installation_uuid


class PeerCommunicationError(Exception):
    pass


def peer_request(path, access_token, *, method="GET", payload=None, query=None):
    base_url = settings.NOTES_SYNC_PEER_URL
    secret = settings.NOTES_SYNC_PEER_SECRET
    if not base_url or len(secret) < 32 or not settings.NOTES_SYNC_PEER_INSTALLATION_ID:
        raise PeerCommunicationError("Notes Bridge peer connection is not configured.")
    if not base_url.startswith("https://"):
        from urllib.parse import urlsplit

        parsed = urlsplit(base_url)
        if not (
            settings.DEBUG
            and parsed.scheme == "http"
            and parsed.hostname in {"localhost", "127.0.0.1"}
        ):
            raise PeerCommunicationError("Notes Bridge peer URL must use HTTPS.")
    if not path.startswith("/api/sync/v1/"):
        raise ValueError("Peer requests must use the versioned sync API.")
    if not access_token:
        raise PeerCommunicationError("The user's verified access token is required.")

    query_string = urlencode(query or {})
    request_path = path + (f"?{query_string}" if query_string else "")
    body = (
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if method.upper() != "GET" else b""
    )
    timestamp = str(int(time.time()))
    nonce = secrets.token_urlsafe(24)
    message = "\n".join((
        method.upper(),
        request_path,
        timestamp,
        nonce,
        hashlib.sha256(body).hexdigest(),
    )).encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
    headers = {
        "Authorization": access_token,
        "Content-Type": "application/json",
        "X-Bridge-Installation": str(installation_uuid()),
        "X-Bridge-Timestamp": timestamp,
        "X-Bridge-Nonce": nonce,
        "X-Bridge-Signature": signature,
    }
    request = Request(
        f"{base_url}{request_path}",
        data=body if method.upper() != "GET" else None,
        headers=headers,
        method=method.upper(),
    )
    try:
        with urlopen(request, timeout=15) as response:
            result = json.loads(response.read())
    except HTTPError as error:
        raise PeerCommunicationError(
            f"The peer returned HTTP {error.code}."
        ) from None
    except (URLError, TimeoutError, OSError, json.JSONDecodeError):
        raise PeerCommunicationError("The peer synchronization service is unavailable.") from None
    if not isinstance(result, dict):
        raise PeerCommunicationError("The peer returned an invalid response.")
    return result
