# Applies the Torrentio patch to upstream torbox-lampa-plugin.js. Fails loudly if the anchor moved.
import re, sys, urllib.request
UP = 'https://slonce70.github.io/addon_lampa_torbox/torbox-lampa-plugin.js'
src = urllib.request.urlopen(UP, timeout=30).read().decode()
anchor = '    return { searchPublicTrackers, checkCached, addMagnet, myList, requestDl };'
if src.count(anchor) != 1:
    sys.exit('anchor not found: upstream changed its Api return, patch needs a manual update')
block = open('torrentio-patch.js').read()
src = src.replace(anchor, block + anchor.replace('searchPublicTrackers,', 'searchPublicTrackers: searchAll,'))
src = re.sub(r"const VERSION = '([^']+)';", r"const VERSION = '\1-en';", src, count=1)
open('torbox-lampa-plugin-en.js', 'w').write(src)
