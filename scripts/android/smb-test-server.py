"""Temporary read-only SMB2 fixture server; expose it only through adb reverse."""
import argparse
from pathlib import Path
from impacket.smbserver import SimpleSMBServer
from impacket.ntlm import compute_lmhash, compute_nthash

parser = argparse.ArgumentParser()
parser.add_argument('library', type=Path)
args = parser.parse_args()
server = SimpleSMBServer(listenAddress='127.0.0.1', listenPort=1445)
server.setSMB2Support(True)
server.addShare('books', str(args.library.resolve()), readOnly='yes')
server.addCredential('inpx-test', 1000, compute_lmhash('android-test'), compute_nthash('android-test'))
print('Read-only SMB fixture listening on localhost:1445', flush=True)
server.start()
