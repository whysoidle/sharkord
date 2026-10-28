import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import config from '../client-config.json';
import './build-assets';

if (process.platform !== 'darwin')
  throw new Error('Build the macOS app on macOS');
const root = resolve(import.meta.dir, '..');
const dist = resolve(root, 'dist');
const app = resolve(dist, 'Sharkord.app');
const run = async (command: string[], cwd = root) => {
  const process = Bun.spawn(command, {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit'
  });
  if (await process.exited) throw new Error(`Command failed: ${command[0]}`);
};
const scratch = resolve(dist, 'macos-release');
const args = [
  'swift',
  'build',
  '--configuration',
  'release',
  '--scratch-path',
  scratch,
  '--arch',
  'arm64',
  '--arch',
  'x86_64'
];
await run(args, resolve(root, 'macos'));
const pathProcess = Bun.spawn([...args, '--show-bin-path'], {
  cwd: resolve(root, 'macos'),
  stdout: 'pipe',
  stderr: 'inherit'
});
const binaryPath = (await new Response(pathProcess.stdout).text()).trim();
if (await pathProcess.exited) throw new Error('Cannot locate the Swift binary');
await rm(app, { recursive: true, force: true });
await mkdir(resolve(app, 'Contents/MacOS'), { recursive: true });
await mkdir(resolve(app, 'Contents/Resources'), { recursive: true });
await cp(
  resolve(binaryPath, 'Sharkord'),
  resolve(app, 'Contents/MacOS/Sharkord')
);
const sdkProcess = Bun.spawn(
  ['xcrun', '--sdk', 'macosx', '--show-sdk-version'],
  { stdout: 'pipe', stderr: 'inherit' }
);
const sdkVersion = (await new Response(sdkProcess.stdout).text()).trim();
if ((await sdkProcess.exited) || !/^\d+\.\d+(\.\d+)?$/.test(sdkVersion))
  throw new Error('Cannot identify the macOS SDK');
// swiftpm's executable can report the deployment target as its SDK; preserve native modern appearance
const executable = resolve(app, 'Contents/MacOS/Sharkord');
await run([
  '/usr/bin/vtool',
  '-set-build-version',
  'macos',
  '14.0',
  sdkVersion,
  '-replace',
  '-output',
  executable + '.sdk',
  executable
]);
await rm(executable);
await cp(executable + '.sdk', executable);
await rm(executable + '.sdk');
await chmod(executable, 0o755);
await cp(
  resolve(root, 'macos/Info.plist'),
  resolve(app, 'Contents/Info.plist')
);
await run([
  '/usr/libexec/PlistBuddy',
  '-c',
  `Set :CFBundleShortVersionString ${config.version}`,
  resolve(app, 'Contents/Info.plist')
]);
await cp(
  resolve(root, 'macos/Sources/Sharkord/Resources/client.js'),
  resolve(app, 'Contents/Resources/client.js')
);
await cp(
  resolve(root, 'macos/update-macos.sh'),
  resolve(app, 'Contents/Resources/update-macos.sh')
);
await cp(
  resolve(root, 'windows/Assets/LICENSES.txt'),
  resolve(app, 'Contents/Resources/LICENSES.txt')
);
// reuse the server's recognizable icon in the native application
const iconset = resolve(dist, 'Sharkord.iconset');
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    await run([
      '/usr/bin/sips',
      '-s',
      'format',
      'png',
      '-z',
      String(size * scale),
      String(size * scale),
      resolve(root, '../client/public/favicon.ico'),
      '--out',
      resolve(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)
    ]);
  }
}
await run([
  '/usr/bin/iconutil',
  '-c',
  'icns',
  iconset,
  '-o',
  resolve(app, 'Contents/Resources/Sharkord.icns')
]);
await run([
  '/usr/libexec/PlistBuddy',
  '-c',
  'Add :CFBundleIconFile string Sharkord',
  resolve(app, 'Contents/Info.plist')
]);
await run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', app]);
await run(['/usr/bin/codesign', '--verify', '--deep', '--strict', app]);
await run([
  '/usr/bin/ditto',
  '-c',
  '-k',
  '--keepParent',
  app,
  resolve(dist, 'Sharkord-macos-universal.zip')
]);
console.log(`Built ${app}`);
