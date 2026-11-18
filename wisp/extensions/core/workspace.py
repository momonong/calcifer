"""Explicit text snapshots; candidate edits never touch the source repository."""
import difflib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile

MAX_FILE = 256 * 1024
MAX_TOTAL = 2 * 1024 * 1024


def relative(value):
    if not isinstance(value, str) or not value or len(value) > 512 or re.search(r'[\\:\x00-\x1f\x7f*?\[\]]', value):
        raise ValueError('INVALID_PATH')
    parts = value.split('/')
    if any(not p or p.startswith('.') for p in parts) or str(PurePosixPath(value)) != value:
        raise ValueError('INVALID_PATH')
    for index, part in enumerate(parts):
        # A reviewed source module such as token_preflight.py computes token
        # counts; it is not a token store. Only this final source-file form is
        # exempt. Names are a heuristic; the explicit task scope is still required.
        token_module = index == len(parts) - 1 and re.fullmatch(r'token_[a-z][a-z0-9_]*\.py', part)
        if not token_module and re.search(r'(?i)^(auth|credentials|secrets|tokens?|id_rsa|id_ed25519)([._-]|$)', part):
            raise ValueError('SECRET_PATH_REJECTED')
    return value


def file_path(root, name, *, absent=False):
    relative(name)
    root = Path(root).absolute()
    for part in (root, *root.parents):
        if part.is_symlink():
            raise ValueError('SYMLINK_REJECTED')
    current = root
    for segment in name.split('/'):
        current = current / segment
        if current.is_symlink():
            raise ValueError('SYMLINK_REJECTED')
        if current.exists() and current != root / name and not current.is_dir():
            raise ValueError('DIRECTORY_REQUIRED')
    if current.exists():
        stat = current.stat()
        if not current.is_file() or stat.st_nlink != 1:
            raise ValueError('REGULAR_SINGLE_LINK_FILE_REQUIRED')
    elif not absent:
        raise ValueError('FILE_NOT_FOUND')
    return current


def read(root, name):
    path = file_path(root, name)
    with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)), 'rb') as stream:
        data = stream.read(MAX_FILE + 1)
    if len(data) > MAX_FILE:
        raise ValueError('FILE_SIZE_LIMIT')
    value = data.decode('utf-8')
    if '\x00' in value:
        raise ValueError('BINARY_REJECTED')
    return value


def snapshot(root, paths):
    if not isinstance(paths, list) or not 1 <= len(paths) <= 64 or len(set(paths)) != len(paths):
        raise ValueError('PATH_COUNT_LIMIT')
    result = {name: read(root, name) if file_path(root, name, absent=True).exists() else None for name in sorted(paths)}
    if sum(len((value or '').encode()) for value in result.values()) > MAX_TOTAL:
        raise ValueError('TOTAL_SIZE_LIMIT')
    return result


def fingerprint(contents):
    return hashlib.sha256(json.dumps(contents, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def file_modes(root, contents):
    return {name: stat.S_IMODE(file_path(root, name).stat().st_mode) if text is not None else None
            for name, text in contents.items()}


def output_mode(original):
    return 0o644 if original is None else original & 0o777


def candidate_snapshot(root, paths):
    contents = snapshot(root, paths)
    files = {Path(name) for name, value in contents.items() if value is not None}
    expected = files | {parent for path in files for parent in path.parents if parent != Path('.')}
    actual = {path.relative_to(root) for path in root.rglob('*')}
    if actual != expected or any((root / path).is_symlink() or not (root / path).is_dir()
                                 for path in expected - files):
        raise ValueError('CANDIDATE_SCOPE_CHANGED')
    return contents, file_modes(root, contents)


def write(root, name, text, *, mode=None):
    if not isinstance(text, str) or '\x00' in text or len(text.encode()) > MAX_FILE:
        raise ValueError('INVALID_FILE_CONTENT')
    target = file_path(root, name, absent=True)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    file_path(root, name, absent=True)
    if mode is None and target.exists():
        mode = target.stat().st_mode
    fd, temporary = tempfile.mkstemp(prefix='.wisp-', dir=target.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as stream:
            stream.write(text)
            stream.flush()
            os.fchmod(stream.fileno(), output_mode(mode))
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def materialize(root, contents, modes):
    Path(root).mkdir(parents=True, mode=0o700)
    for name, text in contents.items():
        if text is not None:
            write(root, name, text, mode=modes[name])


def diff(before, after):
    result = []
    for name in sorted(before):
        if before[name] == after[name]:
            continue
        if before[name] is None and after[name] == '':
            result.append(f'diff --git {json.dumps("a/" + name)} {json.dumps("b/" + name)}\nnew file mode 100644\nindex 0000000..e69de29\n')
            continue
        # A patch must preserve missing final newlines and new-file semantics.
        lines = difflib.unified_diff((before[name] or '').splitlines(keepends=True),
            (after[name] or '').splitlines(keepends=True),
            fromfile='/dev/null' if before[name] is None else 'a/' + name,
            tofile='/dev/null' if after[name] is None else 'b/' + name)
        for line in lines:
            result.append(line if line.endswith('\n') else line + '\n\\ No newline at end of file\n')
    return ''.join(result)


def commands(value):
    if not isinstance(value, list) or len(value) > 8:
        raise ValueError('INVALID_COMMANDS')
    result = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {'id', 'argv'} or not re.fullmatch(r'[a-z][a-z0-9_-]{0,31}', str(item['id'])):
            raise ValueError('INVALID_COMMAND')
        argv = item['argv']
        if not isinstance(argv, list) or not 1 <= len(argv) <= 32 or any(not isinstance(x, str) or not x or len(x) > 4096 or '\x00' in x for x in argv):
            raise ValueError('INVALID_COMMAND')
        if argv[0] not in ('python3', 'python', 'node', 'npm'):
            raise ValueError('COMMAND_EXECUTABLE_NOT_SUPPORTED')
        if any(x['id'] == item['id'] for x in result):
            raise ValueError('DUPLICATE_COMMAND')
        result.append({'id': item['id'], 'argv': list(argv)})
    return result
