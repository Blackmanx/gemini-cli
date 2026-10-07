#!/usr/bin/env python3
"""Turn an corporate .dotx template into a .docx officecli can open.

This is the only thing that is not officecli's job. It refuses .dotx outright -
"Unsupported file type: .dotx" - and no plugin ships for it, while the corporate
Word templates all arrive as .dotx.

Everything else about these documents is done with officecli; see SKILL.md.

Usage:
    from_dotx.py assets/templates/documentacion-proyecto.dotx informe.docx
"""
from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

# A .dotx declares the *template* content type, which is the only thing that
# makes a reader treat it as a template rather than a document. Rewriting that
# one string in [Content_Types].xml yields a file that is otherwise identical:
# same theme, same styles, same header/footer parts, same embedded logos.
_TEMPLATE_CT = (
    b"application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml"
)
_DOCUMENT_CT = (
    b"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
)


def dotx_to_docx(source: Path, out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as workdir:
        staging = Path(workdir) / "staged.docx"
        with zipfile.ZipFile(source) as original, zipfile.ZipFile(
            staging, "w", zipfile.ZIP_DEFLATED
        ) as target:
            for item in original.infolist():
                payload = original.read(item.filename)
                if item.filename == "[Content_Types].xml":
                    payload = payload.replace(_TEMPLATE_CT, _DOCUMENT_CT)
                target.writestr(item, payload)
        shutil.copyfile(staging, out)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="the .dotx template")
    parser.add_argument("output", nargs="?", type=Path, help="the .docx to write")
    args = parser.parse_args()

    if not args.source.exists():
        raise SystemExit(f"plantilla no encontrada: {args.source}")
    if args.source.suffix.lower() != ".dotx":
        raise SystemExit(f"esto es para .dotx; {args.source.name} ya se abre directamente")

    out = args.output or args.source.with_suffix(".docx")
    dotx_to_docx(args.source, out)
    print(f"{out}  (docx from {args.source.name})")


if __name__ == "__main__":
    sys.exit(main())