#!/usr/bin/env python3
"""Private complete instance backup; stdout never contains credentials."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--context', default='orbstack')
parser.add_argument('--output', default='../private-backups/mediary-scout')
args = parser.parse_args()
os.chdir(Path(__file__).resolve().parent.parent)
os.umask(0o077)
dest = Path(args.output).resolve() / datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
dest.mkdir(parents=True, mode=0o700)
docker = ['docker', '--context', args.context]
compose = docker + ['compose']

def save(name, command):
    with (dest / name).open('wb') as out:
        subprocess.run(command, stdout=out, check=True)

containers = subprocess.check_output(compose + ['ps', '-q'], text=True).split()
if not containers:
    raise SystemExit('No running instance; backup aborted')
save('containers.json', docker + ['inspect', *containers])
save('database.dump', compose + ['exec', '-T', 'postgres', 'pg_dump', '-U', 'mediatrack', '-d', 'mediatrack', '-Fc'])
save('compose.resolved.yaml', compose + ['config'])
for name in ['.env', 'docker-compose.yml', 'docker-compose.override.yml']:
    if Path(name).is_file():
        shutil.copyfile(name, dest / name)
# A custom-format dump must be readable by PostgreSQL before declaring success.
with (dest / 'database.dump').open('rb') as stream, (dest / 'database.toc').open('wb') as out:
    subprocess.run(compose + ['exec', '-T', 'postgres', 'pg_restore', '--list'], stdin=stream, stdout=out, check=True)
files = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in dest.iterdir() if p.is_file()}
(dest / 'manifest.json').write_text(json.dumps({'createdAt': datetime.datetime.now().isoformat(), 'files': files}, indent=2))
for path in dest.iterdir():
    path.chmod(0o600)
print(dest)
