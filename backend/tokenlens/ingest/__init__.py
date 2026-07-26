"""Ingestion adapters.

Each adapter converts one source format into `list[Turn]`, so everything
downstream — costing, classification, scoring — is source-agnostic.
"""

from tokenlens.ingest.claude_code import parse_projects, parse_session

__all__ = ["parse_projects", "parse_session"]
