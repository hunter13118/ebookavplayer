"""Cloudflare R2 (S3-compatible) helpers for offline pack blobs."""
from __future__ import annotations

import logging
import os
from typing import BinaryIO

log = logging.getLogger(__name__)


def r2_configured() -> bool:
    return bool(
        os.environ.get("R2_BUCKET")
        and os.environ.get("R2_ACCESS_KEY_ID")
        and os.environ.get("R2_SECRET_ACCESS_KEY")
        and os.environ.get("R2_ACCOUNT_ID")
    )


def _client():
    if not r2_configured():
        raise RuntimeError("R2 not configured")
    import boto3
    from botocore.config import Config

    account = os.environ["R2_ACCOUNT_ID"]
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=Config(signature_version="s3v4"),
    )


def _bucket() -> str:
    return os.environ["R2_BUCKET"]


def pack_object_key(cache_key: str) -> str:
    return f"packs/cache/{cache_key}.vaepack"


def job_object_key(job_id: str) -> str:
    return f"packs/jobs/{job_id}.vaepack"


def put_bytes(key: str, data: bytes, *, content_type: str = "application/zip") -> str:
    client = _client()
    client.put_object(
        Bucket=_bucket(),
        Key=key,
        Body=data,
        ContentType=content_type,
    )
    log.info("r2 put %s (%s bytes)", key, len(data))
    return key


def get_bytes(key: str) -> bytes | None:
    try:
        client = _client()
        resp = client.get_object(Bucket=_bucket(), Key=key)
        return resp["Body"].read()
    except Exception as e:
        if getattr(e, "response", {}).get("Error", {}).get("Code") == "NoSuchKey":
            return None
        if "NoSuchKey" in str(e) or "404" in str(e):
            return None
        raise


def exists(key: str) -> bool:
    try:
        client = _client()
        client.head_object(Bucket=_bucket(), Key=key)
        return True
    except Exception:
        return False


def upload_file(key: str, path: str) -> str:
    with open(path, "rb") as fh:
        return put_bytes(key, fh.read())
