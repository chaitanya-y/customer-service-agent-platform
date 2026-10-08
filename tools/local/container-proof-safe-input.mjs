import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

// A reviewed root is trusted; inspect every component from that root to the leaf.
// This is a local packaging guard, not protection against concurrent filesystem mutation.
export async function assertSafeBuildInput(root, relativePath, expectedType) {
  assert.ok(expectedType === 'file' || expectedType === 'directory', 'Unsupported expected type for build input');
  assert.ok(typeof relativePath === 'string' && relativePath.length > 0 && !isAbsolute(relativePath) && !relativePath.includes('\\'), 'Build input must be an unambiguous nonempty relative path');
  const components = relativePath.split('/');
  for (const component of components) {
    assert.ok(component && component !== '.' && component !== '..', 'Invalid build-input path component');
    assert.ok(!component.startsWith('.') && !/^(?:id_rsa|id_ed25519)$|\.(?:pem|key|p12|pfx)$/i.test(component), 'Hidden or sensitive build-input path component');
  }
  let current = resolve(root);
  let metadata = await lstat(current);
  assert.ok(!metadata.isSymbolicLink(), 'Build root is a symbolic link');
  assert.ok(metadata.isDirectory(), 'Build root must be a directory');
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]);
    metadata = await lstat(current);
    assert.ok(!metadata.isSymbolicLink(), 'Build-input component is a symbolic link');
    if (index < components.length - 1) assert.ok(metadata.isDirectory(), 'Build-input ancestor must be a directory');
  }
  assert.ok(expectedType === 'file' ? metadata.isFile() : metadata.isDirectory(),
    expectedType === 'file' ? 'Build input must be a regular file' : 'Build input must be a directory');
  return metadata;
}
