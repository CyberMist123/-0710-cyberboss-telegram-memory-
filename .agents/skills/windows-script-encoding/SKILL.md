# Windows Script Encoding Safety

Use this skill whenever generating or packaging `.ps1`, `.bat`, or `.cmd` files for Windows users.

## Why

Windows PowerShell 5.1 does not reliably interpret UTF-8 files without a BOM. Non-ASCII text can be decoded as an ANSI code page, corrupting quotes and causing parser errors.

## Rules

1. Keep executable script source ASCII-only by default.
2. Use English runtime messages inside `.ps1`, `.bat`, and `.cmd` files.
3. Put Chinese instructions in a separate documentation file, not in executable source.
4. Write Windows script files with CRLF line endings.
5. Avoid non-ASCII smart quotes, punctuation, comments, and string literals in executable scripts.
6. If non-ASCII script text is unavoidable, write UTF-8 with BOM explicitly and verify it in Windows PowerShell 5.1.
7. Test packaged scripts after ZIP extraction, not only before packaging.
8. Verify that a bundle clone actually materializes every required local branch before replacing remotes or pushing.
9. Never assume remote-tracking branches such as `origin/legacy-current` are local branches.
10. Keep scripts non-destructive: do not delete or modify an existing deployment unless the user explicitly requests it.

## Required checks before delivery

- Confirm executable files report as ASCII, or UTF-8 with BOM when intentionally used.
- Confirm no mojibake appears in the source.
- Confirm all quotes and braces are balanced.
- Confirm all referenced files exist relative to the extracted package directory.
- Confirm the script exits on failed Git commands.
- Confirm the script preserves the current remote branch before any forced update.
- Include a plain-English README with exact launch steps and rollback behavior.
