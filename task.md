# gl package build failure on macOS with Node.js 24+

## Problem

The `gl` package (OpenGL bindings for Node.js) fails to compile on macOS when using Node.js 24+. This blocks installation of editly.

## Solution

**FIXED**: Upgraded `gl` from `^8.1.6` to `^9.0.0-rc.9`

The `gl@9.0.0-rc.9` release includes prebuilt binaries for Node.js 24 (v137 ABI) on macOS arm64.

```bash
npm install  # works with gl@9.0.0-rc.9
npm test     # all 16 tests pass
npm run build # builds successfully
```

## Bun Compatibility

**WARNING**: Bun does NOT work with the `gl` package due to a bun bug with native modules.
See: https://github.com/oven-sh/bun/issues/18779

Bun crashes with segmentation fault when loading `webgl.node`. This is a bun runtime bug, not an editly issue.

**Use Node.js** for now until bun fixes their native module loading.

## Original Build Error (gl@8.1.6)

```
fatal error: too many errors emitted, stopping now [-ferror-limit=]
3 warnings and 20 errors generated.
make: *** [Release/obj.target/webgl/src/native/procs.o] Error 1
make: *** [Release/obj.target/webgl/src/native/bindings.o] Error 1
make: *** [Release/obj.target/webgl/src/native/webgl.o] Error 1
gyp ERR! build error
gyp ERR! stack Error: `make` failed with exit code: 2
```

The C++ code in `gl@8.x` was incompatible with Node.js 24's V8 headers:

```
/Users/aleks/Library/Caches/node-gyp/24.5.0/include/node/v8-internal.h:780:42: warning: 'static_assert' with no message is a C++17 extension [-Wc++17-extensions]
```

## Environment

- macOS Darwin 25.3.0 (arm64)
- Node.js v24.5.0 / v24.7.0
- node-gyp v9.4.1
- Python 3.14.2
- gl package version: ^9.0.0-rc.9 (fixed)

## Additional issues encountered during troubleshooting

1. Python 3.14 removed `distutils` module - required `pip3 install setuptools`
2. `python` command not found - `gl` build scripts call `python` instead of `python3`

## Related issues

- https://github.com/mifi/editly/issues/286
- https://github.com/mifi/editly/issues/249
- https://github.com/oven-sh/bun/issues/18779 (bun native module crash)
