#!/usr/bin/env python3
"""Credential-safe CLI for the Mediary Scout share import API."""
import argparse
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--connection', type=Path, default=Path(os.environ.get('MEDIA_SCOUT_CONNECTION', '~/.mediary-scout/agent.json')).expanduser())
    sub = parser.add_subparsers(dest='command', required=True)
    submit = sub.add_parser('import')
    submit.add_argument('--url', required=True)
    for name in ['password', 'query', 'storage-id']:
        submit.add_argument('--' + name)
    submit.add_argument('--type', choices=['tv', 'movie'])
    submit.add_argument('--tmdb-id', type=int)
    submit.add_argument('--season', type=int)
    for name in ['status', 'retry']:
        sub.add_parser(name).add_argument('--id', required=True)
    sub.add_parser('drives')
    args = parser.parse_args()
    try:
        connection = json.loads(args.connection.read_text())
        base, token = connection['baseUrl'].rstrip('/'), connection['token']
    except (OSError, ValueError, KeyError):
        parser.error('Missing or invalid connection file (requires baseUrl and token)')
    body = None
    path = '/api/agent/config'
    method = 'GET'
    if args.command == 'import':
        body = {key: getattr(args, attr) for key, attr in [('url', 'url'), ('password', 'password'), ('query', 'query'), ('type', 'type'), ('tmdbId', 'tmdb_id'), ('season', 'season'), ('storageId', 'storage_id')] if getattr(args, attr) is not None}
        path, method = '/api/agent/import-share', 'POST'
    elif args.command in ['status', 'retry']:
        from urllib.parse import quote
        path = '/api/agent/import-share/' + quote(args.id, safe='')
        if args.command == 'retry':
            path += '/retry'
            body, method = {}, 'POST'
    request = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method=method)
    # The connection file explicitly identifies the server; never leak its bearer
    # to a redirect target or through a user's unrelated system HTTP proxy.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=90) as response:
            result = json.load(response)
        if args.command == 'drives':
            result = result.get('storages', [])
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except urllib.error.HTTPError as error:
        try:
            result = json.loads(error.read())
        except ValueError:
            result = {'error': 'Non-JSON response'}
        print(json.dumps({'httpStatus': error.code, 'result': result}, ensure_ascii=False, indent=2))
        return 1
    except (urllib.error.URLError, TimeoutError):
        print('Cannot reach the configured Mediary Scout instance.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
