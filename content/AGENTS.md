# pdf-analyze

When a user asks to read, inspect, summarize, extract, or analyze a local PDF, first check for MinerU cached output under `<pdf parent>/.mineru/<pdf file stem>/`. If usable Markdown, text, or JSON exists there, read from that cache before opening or reparsing the original PDF. Only call MinerU again when the cache is missing, incomplete, stale for the current request, or the user explicitly asks to reparse.

When moving or renaming a PDF, also move or rename its MinerU cache folder so the cache remains next to the PDF. For a PDF at `<dir>/<name>.pdf`, the cache folder is `<dir>/.mineru/<name>/`; if the PDF moves to `<new-dir>/<new-name>.pdf`, move that cache folder to `<new-dir>/.mineru/<new-name>/` when it exists.
