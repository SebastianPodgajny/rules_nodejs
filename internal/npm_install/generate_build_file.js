/* THIS FILE GENERATED FROM .ts; see BUILD.bazel */ /* clang-format off */(function (factory) {
    if (typeof module === "object" && typeof module.exports === "object") {
        var v = factory(require, exports);
        if (v !== undefined) module.exports = v;
    }
    else if (typeof define === "function" && define.amd) {
        define("build_bazel_rules_nodejs/internal/npm_install/generate_build_file", ["require", "exports", "fs", "path", "crypto"], factory);
    }
})(function (require, exports) {
    /**
     * @license
     * Copyright 2017 The Bazel Authors. All rights reserved.
     *
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     *
     * You may obtain a copy of the License at
     *     http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     */
    /**
     * @fileoverview This script generates BUILD.bazel files by analyzing
     * the node_modules folder layed out by yarn or npm. It generates
     * fine grained Bazel `node_module_library` targets for each root npm package
     * and all files for that package and its transitive deps are included
     * in the target. For example, `@<workspace>//jasmine` would
     * include all files in the jasmine npm package and all of its
     * transitive dependencies.
     *
     * nodejs_binary targets are also generated for all `bin` scripts
     * in each package. For example, the `@<workspace>//jasmine/bin:jasmine`
     * target will be generated for the `jasmine` binary in the `jasmine`
     * npm package.
     *
     * Additionally, a `@<workspace>//:node_modules` `node_module_library`
     * is generated that includes all packages under node_modules
     * as well as the .bin folder.
     *
     * This work is based off the fine grained deps concepts in
     * https://github.com/pubref/rules_node developed by @pcj.
     *
     * @see https://docs.google.com/document/d/1AfjHMLVyE_vYwlHSK7k7yW_IIGppSxsQtPm9PTr1xEo
     */
    'use strict';
    Object.defineProperty(exports, "__esModule", { value: true });
    const fs = require("fs");
    const path = require("path");
    const crypto = require("crypto");
    function log_verbose(...m) {
        if (!!process.env['VERBOSE_LOGS'])
            console.error('[generate_build_file.js]', ...m);
    }
    const BUILD_FILE_HEADER = `# Generated file from yarn_install/npm_install rule.
# See $(bazel info output_base)/external/build_bazel_rules_nodejs/internal/npm_install/generate_build_file.js

# All rules in other repositories can use these targets
package(default_visibility = ["//visibility:public"])

`;
    const args = process.argv.slice(2);
    const WORKSPACE = args[0];
    const RULE_TYPE = args[1];
    const ERROR_ON_BAZEL_FILES = parseInt(args[2]);
    const LOCK_FILE_PATH = args[3];
    const INCLUDED_FILES = args[4] ? args[4].split(',') : [];
    const DYNAMIC_DEPS = JSON.parse(args[5] || '{}');
    if (require.main === module) {
        main();
    }
    /**
     * Create a new directory and any necessary subdirectories
     * if they do not exist.
     */
    function mkdirp(p) {
        if (!fs.existsSync(p)) {
            mkdirp(path.dirname(p));
            fs.mkdirSync(p);
        }
    }
    /**
     * Writes a file, first ensuring that the directory to
     * write to exists.
     */
    function writeFileSync(p, content) {
        mkdirp(path.dirname(p));
        fs.writeFileSync(p, content);
    }
    /**
     * Main entrypoint.
     */
    function main() {
        // find all packages (including packages in nested node_modules)
        const pkgs = findPackages();
        // flatten dependencies
        flattenDependencies(pkgs);
        // generate Bazel workspaces
        generateBazelWorkspaces(pkgs);
        // generate all BUILD files
        generateBuildFiles(pkgs);
    }
    module.exports = {
        main,
        printPackageBin,
        addDynamicDependencies,
        printIndexBzl,
    };
    /**
     * Generates all build files
     */
    function generateBuildFiles(pkgs) {
        generateRootBuildFile(pkgs.filter(pkg => !pkg._isNested));
        pkgs.filter(pkg => !pkg._isNested).forEach(pkg => generatePackageBuildFiles(pkg));
        findScopes().forEach(scope => generateScopeBuildFiles(scope, pkgs));
    }
    /**
     * Flattens dependencies on all packages
     */
    function flattenDependencies(pkgs) {
        const pkgsMap = new Map();
        pkgs.forEach(pkg => pkgsMap.set(pkg._dir, pkg));
        pkgs.forEach(pkg => flattenPkgDependencies(pkg, pkg, pkgsMap));
    }
    /**
     * Handles Bazel files in npm distributions.
     */
    function hideBazelFiles(pkg) {
        const hasHideBazelFiles = isDirectory('node_modules/@bazel/hide-bazel-files');
        pkg._files = pkg._files.map(file => {
            const basename = path.basename(file);
            const basenameUc = basename.toUpperCase();
            if (basenameUc === 'BUILD' || basenameUc === 'BUILD.BAZEL') {
                // If bazel files are detected and there is no @bazel/hide-bazel-files npm
                // package then error out and suggest adding the package. It is possible to
                // have bazel BUILD files with the package installed as it's postinstall
                // step, which hides bazel BUILD files, only runs when the @bazel/hide-bazel-files
                // is installed and not when new packages are added (via `yarn add`
                // for example) after the initial install. In this case, however, the repo rule
                // will re-run as the package.json && lock file has changed so we just
                // hide the added BUILD files during the repo rule run here since @bazel/hide-bazel-files
                // was not run.
                if (!hasHideBazelFiles && ERROR_ON_BAZEL_FILES) {
                    console.error(`npm package '${pkg._dir}' from @${WORKSPACE} ${RULE_TYPE} rule
has a Bazel BUILD file '${file}'. Use the @bazel/hide-bazel-files utility to hide these files.
See https://github.com/bazelbuild/rules_nodejs/blob/master/packages/hide-bazel-files/README.md
for installation instructions.`);
                    process.exit(1);
                }
                else {
                    // All Bazel files in the npm distribution should be renamed by
                    // adding a `_` prefix so that file targets don't cross package boundaries.
                    const newFile = path.posix.join(path.dirname(file), `_${basename}`);
                    const srcPath = path.posix.join('node_modules', pkg._dir, file);
                    const dstPath = path.posix.join('node_modules', pkg._dir, newFile);
                    fs.renameSync(srcPath, dstPath);
                    return newFile;
                }
            }
            return file;
        });
    }
    /**
     * Generates the root BUILD file.
     */
    function generateRootBuildFile(pkgs) {
        let exportsStarlark = '';
        pkgs.forEach(pkg => {
            pkg._files.forEach(f => {
                exportsStarlark += `    "node_modules/${pkg._dir}/${f}",
`;
            });
        });
        let srcsStarlark = '';
        if (pkgs.length) {
            const list = pkgs.map(pkg => `"//${pkg._dir}:${pkg._name}__files",`).join('\n        ');
            srcsStarlark = `
    # direct sources listed for strict deps support
    srcs = [
        ${list}
    ],`;
        }
        let depsStarlark = '';
        if (pkgs.length) {
            const list = pkgs.map(pkg => `"//${pkg._dir}:${pkg._name}__contents",`).join('\n        ');
            depsStarlark = `
    # flattened list of direct and transitive dependencies hoisted to root by the package manager
    deps = [
        ${list}
    ],`;
        }
        let buildFile = BUILD_FILE_HEADER +
            `load("@build_bazel_rules_nodejs//internal/npm_install:node_module_library.bzl", "node_module_library")

exports_files([
${exportsStarlark}])

# The node_modules directory in one catch-all node_module_library.
# NB: Using this target may have bad performance implications if
# there are many files in target.
# See https://github.com/bazelbuild/bazel/issues/5153.
node_module_library(
    name = "node_modules",${srcsStarlark}${depsStarlark}
)

`;
        // Add the manual build file contents if they exists
        try {
            buildFile += fs.readFileSync(`manual_build_file_contents`, { encoding: 'utf8' });
        }
        catch (e) {
        }
        writeFileSync('BUILD.bazel', buildFile);
    }
    /**
     * Generates all BUILD & bzl files for a package.
     */
    function generatePackageBuildFiles(pkg) {
        let buildFile = printPackage(pkg);
        const binBuildFile = printPackageBin(pkg);
        if (binBuildFile.length) {
            writeFileSync(path.posix.join(pkg._dir, 'bin', 'BUILD.bazel'), BUILD_FILE_HEADER + binBuildFile);
        }
        const indexFile = printIndexBzl(pkg);
        if (indexFile.length) {
            writeFileSync(path.posix.join(pkg._dir, 'index.bzl'), indexFile);
            buildFile = `${buildFile}
# For integration testing
exports_files(["index.bzl"])
`;
        }
        writeFileSync(path.posix.join(pkg._dir, 'BUILD.bazel'), BUILD_FILE_HEADER + buildFile);
    }
    /**
     * Generate install_<workspace_name>.bzl files with function to install each workspace.
     */
    function generateBazelWorkspaces(pkgs) {
        const workspaces = {};
        for (const pkg of pkgs) {
            if (!pkg.bazelWorkspaces) {
                continue;
            }
            for (const workspace of Object.keys(pkg.bazelWorkspaces)) {
                // A bazel workspace can only be setup by one npm package
                if (workspaces[workspace]) {
                    console.error(`Could not setup Bazel workspace ${workspace} requested by npm ` +
                        `package ${pkg._dir}@${pkg.version}. Already setup by ${workspaces[workspace]}`);
                    process.exit(1);
                }
                generateBazelWorkspace(pkg, workspace);
                // Keep track of which npm package setup this bazel workspace for later use
                workspaces[workspace] = `${pkg._dir}@${pkg.version}`;
            }
        }
        // Finally generate install_bazel_dependencies.bzl
        generateInstallBazelDependencies(Object.keys(workspaces));
    }
    /**
     * Generate install_<workspace>.bzl file with function to install the workspace.
     */
    function generateBazelWorkspace(pkg, workspace) {
        let bzlFile = `# Generated by the yarn_install/npm_install rule
load("@build_bazel_rules_nodejs//internal/copy_repository:copy_repository.bzl", "copy_repository")

def _maybe(repo_rule, name, **kwargs):
    if name not in native.existing_rules():
        repo_rule(name = name, **kwargs)
`;
        const rootPath = pkg.bazelWorkspaces[workspace].rootPath;
        if (!rootPath) {
            console.error(`Malformed bazelWorkspaces attribute in ${pkg._dir}@${pkg.version}. ` +
                `Missing rootPath for workspace ${workspace}.`);
            process.exit(1);
        }
        // Copy all files for this workspace to a folder under _workspaces
        // to restore the Bazel files which have be renamed from the npm package
        const workspaceSourcePath = path.posix.join('_workspaces', workspace);
        mkdirp(workspaceSourcePath);
        pkg._files.forEach(file => {
            if (/^node_modules[/\\]/.test(file)) {
                // don't copy over nested node_modules
                return;
            }
            let destFile = path.relative(rootPath, file);
            if (destFile.startsWith('..')) {
                // this file is not under the rootPath
                return;
            }
            const basename = path.basename(file);
            const basenameUc = basename.toUpperCase();
            // Bazel BUILD files from npm distribution would have been renamed earlier with a _ prefix so
            // we restore the name on the copy
            if (basenameUc === '_BUILD' || basenameUc === '_BUILD.BAZEL') {
                destFile = path.posix.join(path.dirname(destFile), basename.substr(1));
            }
            const src = path.posix.join('node_modules', pkg._dir, file);
            const dest = path.posix.join(workspaceSourcePath, destFile);
            mkdirp(path.dirname(dest));
            fs.copyFileSync(src, dest);
        });
        // We create _bazel_workspace_marker that is used by the custom copy_repository
        // rule to resolve the path to the repository source root. A root BUILD file
        // is required to reference _bazel_workspace_marker as a target so we also create
        // an empty one if one does not exist.
        if (!hasRootBuildFile(pkg, rootPath)) {
            writeFileSync(path.posix.join(workspaceSourcePath, 'BUILD.bazel'), '# Marker file that this directory is a bazel package');
        }
        const sha256sum = crypto.createHash('sha256');
        sha256sum.update(fs.readFileSync(LOCK_FILE_PATH, { encoding: 'utf8' }));
        writeFileSync(path.posix.join(workspaceSourcePath, '_bazel_workspace_marker'), `# Marker file to used by custom copy_repository rule\n${sha256sum.digest('hex')}`);
        bzlFile += `def install_${workspace}():
    _maybe(
        copy_repository,
        name = "${workspace}",
        marker_file = "@${WORKSPACE}//_workspaces/${workspace}:_bazel_workspace_marker",
    )
`;
        writeFileSync(`install_${workspace}.bzl`, bzlFile);
    }
    /**
     * Generate install_bazel_dependencies.bzl with function to install all workspaces.
     */
    function generateInstallBazelDependencies(workspaces) {
        let bzlFile = `# Generated by the yarn_install/npm_install rule
`;
        workspaces.forEach(workspace => {
            bzlFile += `load(\":install_${workspace}.bzl\", \"install_${workspace}\")
`;
        });
        bzlFile += `def install_bazel_dependencies():
    """Installs all workspaces listed in bazelWorkspaces of all npm packages"""
`;
        workspaces.forEach(workspace => {
            bzlFile += `    install_${workspace}()
`;
        });
        writeFileSync('install_bazel_dependencies.bzl', bzlFile);
    }
    /**
     * Generate build files for a scope.
     */
    function generateScopeBuildFiles(scope, pkgs) {
        const buildFile = BUILD_FILE_HEADER + printScope(scope, pkgs);
        writeFileSync(path.posix.join(scope, 'BUILD.bazel'), buildFile);
    }
    /**
     * Checks if a path is a file.
     */
    function isFile(p) {
        return fs.existsSync(p) && fs.statSync(p).isFile();
    }
    /**
     * Checks if a path is an npm package which is is a directory with a package.json file.
     */
    function isDirectory(p) {
        return fs.existsSync(p) && fs.statSync(p).isDirectory();
    }
    /**
     * Returns an array of all the files under a directory as relative
     * paths to the directory.
     */
    function listFiles(rootDir, subDir = '') {
        const dir = path.posix.join(rootDir, subDir);
        if (!isDirectory(dir)) {
            return [];
        }
        return fs.readdirSync(dir)
            .reduce((files, file) => {
            const fullPath = path.posix.join(dir, file);
            const relPath = path.posix.join(subDir, file);
            const isSymbolicLink = fs.lstatSync(fullPath).isSymbolicLink();
            let stat;
            try {
                stat = fs.statSync(fullPath);
            }
            catch (e) {
                if (isSymbolicLink) {
                    // Filter out broken symbolic links. These cause fs.statSync(fullPath)
                    // to fail with `ENOENT: no such file or directory ...`
                    return files;
                }
                throw e;
            }
            const isDirectory = stat.isDirectory();
            if (isDirectory && isSymbolicLink) {
                // Filter out symbolic links to directories. An issue in yarn versions
                // older than 1.12.1 creates symbolic links to folders in the .bin folder
                // which leads to Bazel targets that cross package boundaries.
                // See https://github.com/bazelbuild/rules_nodejs/issues/428 and
                // https://github.com/bazelbuild/rules_nodejs/issues/438.
                // This is tested in /e2e/fine_grained_symlinks.
                return files;
            }
            return isDirectory ? files.concat(listFiles(rootDir, relPath)) : files.concat(relPath);
        }, [])
            // Files with spaces (\x20) or unicode characters (<\x20 && >\x7E) are not allowed in
            // Bazel runfiles. See https://github.com/bazelbuild/bazel/issues/4327
            .filter(f => !/[^\x21-\x7E]/.test(f))
            // We return a sorted array so that the order of files
            // is the same regardless of platform
            .sort();
    }
    /**
     * Returns true if the npm package distribution contained a
     * root /BUILD or /BUILD.bazel file.
     */
    function hasRootBuildFile(pkg, rootPath) {
        for (const file of pkg._files) {
            // Bazel files would have been renamed earlier with a `_` prefix
            const fileUc = path.relative(rootPath, file).toUpperCase();
            if (fileUc === '_BUILD' || fileUc === '_BUILD.BAZEL') {
                return true;
            }
        }
        return false;
    }
    function addDynamicDependencies(pkgs, dynamic_deps = DYNAMIC_DEPS) {
        function match(name, p) {
            // Automatically include dynamic dependency on plugins of the form pkg-plugin-foo
            if (name.startsWith(`${p._moduleName}-plugin-`))
                return true;
            const value = dynamic_deps[p._moduleName];
            if (name === value)
                return true;
            // Support wildcard match
            if (value && value.includes('*') && name.startsWith(value.substring(0, value.indexOf('*')))) {
                return true;
            }
            return false;
        }
        pkgs.forEach(p => {
            p._dynamicDependencies =
                pkgs.filter(
                // Filter entries like
                // "_dir":"check-side-effects/node_modules/rollup-plugin-node-resolve"
                x => !x._dir.includes('/node_modules/') && !!x._moduleName &&
                    match(x._moduleName, p))
                    .map(dyn => `//${dyn._dir}:${dyn._name}`);
        });
    }
    /**
     * Finds and returns an array of all packages under a given path.
     */
    function findPackages(p = 'node_modules') {
        if (!isDirectory(p)) {
            return [];
        }
        const pkgs = [];
        const listing = fs.readdirSync(p);
        const packages = listing
            // filter out scopes
            .filter(f => !f.startsWith('@'))
            // filter out folders such as `.bin` which can create
            // issues on Windows since these are "hidden" by default
            .filter(f => !f.startsWith('.'))
            .map(f => path.posix.join(p, f))
            .filter(f => isDirectory(f));
        packages.forEach(f => pkgs.push(parsePackage(f), ...findPackages(path.posix.join(f, 'node_modules'))));
        const scopes = listing.filter(f => f.startsWith('@'))
            .map(f => path.posix.join(p, f))
            .filter(f => isDirectory(f));
        scopes.forEach(f => pkgs.push(...findPackages(f)));
        addDynamicDependencies(pkgs);
        return pkgs;
    }
    /**
     * Finds and returns an array of all package scopes in node_modules.
     */
    function findScopes() {
        const p = 'node_modules';
        if (!isDirectory(p)) {
            return [];
        }
        const listing = fs.readdirSync(p);
        const scopes = listing.filter(f => f.startsWith('@'))
            .map(f => path.posix.join(p, f))
            .filter(f => isDirectory(f))
            .map(f => f.replace(/^node_modules\//, ''));
        return scopes;
    }
    /**
     * Given the name of a top-level folder in node_modules, parse the
     * package json and return it as an object along with
     * some additional internal attributes prefixed with '_'.
     */
    function parsePackage(p) {
        // Parse the package.json file of this package
        const packageJson = path.posix.join(p, 'package.json');
        const pkg = isFile(packageJson) ? JSON.parse(fs.readFileSync(packageJson, { encoding: 'utf8' })) :
            { version: '0.0.0' };
        // Trim the leading node_modules from the path and
        // assign to _dir for future use
        pkg._dir = p.replace(/^node_modules\//, '');
        // Stash the package directory name for future use
        pkg._name = pkg._dir.split('/').pop();
        // Module name of the package. Unlike "_name" this represents the
        // full package name (including scope name).
        pkg._moduleName = pkg.name || `${pkg._dir}/${pkg._name}`;
        // Keep track of whether or not this is a nested package
        pkg._isNested = /\/node_modules\//.test(p);
        // List all the files in the npm package for later use
        pkg._files = listFiles(p);
        // Initialize _dependencies to an empty array
        // which is later filled with the flattened dependency list
        pkg._dependencies = [];
        // Hide bazel files in this package. We do this before parsing
        // the next package to prevent issues caused by symlinks between
        // package and nested packages setup by the package manager.
        hideBazelFiles(pkg);
        return pkg;
    }
    /**
     * Check if a bin entry is a non-empty path
     */
    function isValidBinPath(entry) {
        return isValidBinPathStringValue(entry) || isValidBinPathObjectValues(entry);
    }
    /**
     * If given a string, check if a bin entry is a non-empty path
     */
    function isValidBinPathStringValue(entry) {
        return typeof entry === 'string' && entry !== '';
    }
    /**
     * If given an object literal, check if a bin entry objects has at least one a non-empty path
     * Example 1: { entry: './path/to/script.js' } ==> VALID
     * Example 2: { entry: '' } ==> INVALID
     * Example 3: { entry: './path/to/script.js', empty: '' } ==> VALID
     */
    function isValidBinPathObjectValues(entry) {
        // We allow at least one valid entry path (if any).
        return entry && typeof entry === 'object' &&
            Object['values'](entry).filter(_entry => isValidBinPath(_entry)).length > 0;
    }
    /**
     * Cleanup a package.json "bin" path.
     *
     * Bin paths usually come in 2 flavors: './bin/foo' or 'bin/foo',
     * sometimes other stuff like 'lib/foo'.  Remove prefix './' if it
     * exists.
     */
    function cleanupBinPath(p) {
        p = p.replace(/\\/g, '/');
        if (p.indexOf('./') === 0) {
            p = p.slice(2);
        }
        return p;
    }
    /**
     * Cleanup a package.json entry point such as "main"
     *
     * Removes './' if it exists.
     * Appends `index.js` if p ends with `/`.
     */
    function cleanupEntryPointPath(p) {
        p = p.replace(/\\/g, '/');
        if (p.indexOf('./') === 0) {
            p = p.slice(2);
        }
        if (p.endsWith('/')) {
            p += 'index.js';
        }
        return p;
    }
    /**
     * Cleans up the given path
     * Then tries to resolve the path into a file and warns if VERBOSE_LOGS set and the file dosen't
     * exist
     * @param {any} pkg
     * @param {string} path
     * @returns {string | undefined}
     */
    function findEntryFile(pkg, path) {
        const cleanPath = cleanupEntryPointPath(path);
        // check if main entry point exists
        const entryFile = findFile(pkg, cleanPath) || findFile(pkg, `${cleanPath}.js`);
        if (!entryFile) {
            // If entryPoint entry point listed could not be resolved to a file
            // This can happen
            // in some npm packages that list an incorrect main such as v8-coverage@1.0.8
            // which lists `"main": "index.js"` but that file does not exist.
            log_verbose(`could not find entry point for the path ${cleanPath} given by npm package ${pkg._name}`);
        }
        return entryFile;
    }
    /**
     * Tries to resolve the entryPoint file from the pkg for a given mainFileName
     *
     * @param {any} pkg
     * @param {'browser' | 'module' | 'main'} mainFileName
     * @returns {string | undefined} the path or undefined if we cant resolve the file
     */
    function resolveMainFile(pkg, mainFileName) {
        const mainEntryField = pkg[mainFileName];
        if (mainEntryField) {
            if (typeof mainEntryField === 'string') {
                return findEntryFile(pkg, mainEntryField);
            }
            else if (typeof mainEntryField === 'object' && mainFileName === 'browser') {
                // browser has a weird way of defining this
                // the browser value is an object listing files to alias, usually pointing to a browser dir
                const indexEntryPoint = mainEntryField['index.js'] || mainEntryField['./index.js'];
                if (indexEntryPoint) {
                    return findEntryFile(pkg, indexEntryPoint);
                }
            }
        }
    }
    /**
     * Tries to resolve the mainFile from a given pkg
     * This uses seveal mainFileNames in priority to find a correct usable file
     * @param {any} pkg
     * @returns {string | undefined}
     */
    function resolvePkgMainFile(pkg) {
        // es2015 is another option for mainFile here
        // but its very uncommon and im not sure what priority it takes
        //
        // this list is ordered, we try resolve `browser` first, then `module` and finally fall back to
        // `main`
        const mainFileNames = ['browser', 'module', 'main'];
        for (const mainFile of mainFileNames) {
            const resolvedMainFile = resolveMainFile(pkg, mainFile);
            if (resolvedMainFile) {
                return resolvedMainFile;
            }
        }
        // if we cant find any correct file references from the pkg
        // then we just try looking around for common patterns
        const maybeRootIndex = findEntryFile(pkg, 'index.js');
        if (maybeRootIndex) {
            return maybeRootIndex;
        }
        const maybeSelfNamedIndex = findEntryFile(pkg, `${pkg._name}.js`);
        if (maybeSelfNamedIndex) {
            return maybeSelfNamedIndex;
        }
        // none of the methods we tried resulted in a file
        log_verbose(`could not find entry point for npm package ${pkg._name}`);
        // at this point there's nothing left for us to try, so return nothing
        return undefined;
    }
    /**
     * Flattens all transitive dependencies of a package
     * into a _dependencies array.
     */
    function flattenPkgDependencies(pkg, dep, pkgsMap) {
        if (pkg._dependencies.indexOf(dep) !== -1) {
            // circular dependency
            return;
        }
        pkg._dependencies.push(dep);
        const findDeps = function (targetDeps, required, depType) {
            Object.keys(targetDeps || {})
                .map(targetDep => {
                // look for matching nested package
                const dirSegments = dep._dir.split('/');
                while (dirSegments.length) {
                    const maybe = path.posix.join(...dirSegments, 'node_modules', targetDep);
                    if (pkgsMap.has(maybe)) {
                        return pkgsMap.get(maybe);
                    }
                    dirSegments.pop();
                }
                // look for matching root package
                if (pkgsMap.has(targetDep)) {
                    return pkgsMap.get(targetDep);
                }
                // dependency not found
                if (required) {
                    console.error(`could not find ${depType} '${targetDep}' of '${dep._dir}'`);
                    process.exit(1);
                }
                return null;
            })
                .filter(dep => !!dep)
                .forEach(dep => flattenPkgDependencies(pkg, dep, pkgsMap));
        };
        // npm will in some cases add optionalDependencies to the list
        // of dependencies to the package.json it writes to node_modules.
        // We delete these here if they exist as they may result
        // in expected dependencies that are not found.
        if (dep.dependencies && dep.optionalDependencies) {
            Object.keys(dep.optionalDependencies).forEach(optionalDep => {
                delete dep.dependencies[optionalDep];
            });
        }
        findDeps(dep.dependencies, true, 'dependency');
        findDeps(dep.peerDependencies, true, 'peer dependency');
        // `optionalDependencies` that are missing should be silently
        // ignored since the npm/yarn will not fail if these dependencies
        // fail to install. Packages should handle the cases where these
        // dependencies are missing gracefully at runtime.
        // An example of this is the `chokidar` package which specifies
        // `fsevents` as an optionalDependency. On OSX, `fsevents`
        // is installed successfully, but on Windows & Linux, `fsevents`
        // fails to install and the package will not be present when
        // checking the dependencies of `chokidar`.
        findDeps(dep.optionalDependencies, false, 'optional dependency');
    }
    /**
     * Reformat/pretty-print a json object as a skylark comment (each line
     * starts with '# ').
     */
    function printJson(pkg) {
        // Clone and modify _dependencies to avoid circular issues when JSONifying
        // & delete _files array
        const cloned = Object.assign({}, pkg);
        cloned._dependencies = pkg._dependencies.map(dep => dep._dir);
        delete cloned._files;
        return JSON.stringify(cloned, null, 2).split('\n').map(line => `# ${line}`).join('\n');
    }
    /**
     * A filter function for files in an npm package. Comparison is case-insensitive.
     * @param files array of files to filter
     * @param exts list of white listed case-insensitive extensions; if empty, no filter is
     *             done on extensions; '' empty string denotes to allow files with no extensions,
     *             other extensions are listed with '.ext' notation such as '.d.ts'.
     */
    function filterFiles(files, exts = []) {
        if (exts.length) {
            const allowNoExts = exts.includes('');
            files = files.filter(f => {
                // include files with no extensions if noExt is true
                if (allowNoExts && !path.extname(f))
                    return true;
                // filter files in exts
                const lc = f.toLowerCase();
                for (const e of exts) {
                    if (e && lc.endsWith(e.toLowerCase())) {
                        return true;
                    }
                }
                return false;
            });
        }
        // Filter out BUILD files that came with the npm package
        return files.filter(file => {
            const basenameUc = path.basename(file).toUpperCase();
            if (basenameUc === '_BUILD' || basenameUc === '_BUILD.BAZEL') {
                return false;
            }
            return true;
        });
    }
    /**
     * Returns true if the specified `pkg` conforms to Angular Package Format (APF),
     * false otherwise. If the package contains `*.metadata.json` and a
     * corresponding sibling `.d.ts` file, then the package is considered to be APF.
     */
    function isNgApfPackage(pkg) {
        const set = new Set(pkg._files);
        if (set.has('ANGULAR_PACKAGE')) {
            // This file is used by the npm/yarn_install rule to detect APF. See
            // https://github.com/bazelbuild/rules_nodejs/issues/927
            return true;
        }
        const metadataExt = /\.metadata\.json$/;
        return pkg._files.some((file) => {
            if (metadataExt.test(file)) {
                const sibling = file.replace(metadataExt, '.d.ts');
                if (set.has(sibling)) {
                    return true;
                }
            }
            return false;
        });
    }
    /**
     * If the package is in the Angular package format returns list
     * of package files that end with `.umd.js`, `.ngfactory.js` and `.ngsummary.js`.
     */
    function getNgApfScripts(pkg) {
        return isNgApfPackage(pkg) ?
            filterFiles(pkg._files, ['.umd.js', '.ngfactory.js', '.ngsummary.js']) :
            [];
    }
    /**
     * Looks for a file within a package and returns it if found.
     */
    function findFile(pkg, m) {
        const ml = m.toLowerCase();
        for (const f of pkg._files) {
            if (f.toLowerCase() === ml) {
                return f;
            }
        }
        return undefined;
    }
    /**
     * Given a pkg, return the skylark `node_module_library` targets for the package.
     */
    function printPackage(pkg) {
        const sources = filterFiles(pkg._files, INCLUDED_FILES);
        const dtsSources = filterFiles(pkg._files, ['.d.ts']);
        // TODO(gmagolan): add UMD & AMD scripts to scripts even if not an APF package _but_ only if they
        // are named?
        const namedSources = getNgApfScripts(pkg);
        const deps = [pkg].concat(pkg._dependencies.filter(dep => dep !== pkg && !dep._isNested));
        let namedSourcesStarlark = '';
        if (namedSources.length) {
            namedSourcesStarlark = `
    # subset of srcs that are javascript named-UMD or named-AMD scripts
    named_sources = [
        ${namedSources.map((f) => `"//:node_modules/${pkg._dir}/${f}",`).join('\n        ')}
    ],`;
        }
        let srcsStarlark = '';
        if (sources.length) {
            srcsStarlark = `
    # ${pkg._dir} package files (and files in nested node_modules)
    srcs = [
        ${sources.map((f) => `"//:node_modules/${pkg._dir}/${f}",`).join('\n        ')}
    ],`;
        }
        let depsStarlark = '';
        if (deps.length) {
            const list = deps.map(dep => `"//${dep._dir}:${dep._name}__contents",`).join('\n        ');
            depsStarlark = `
    # flattened list of direct and transitive dependencies hoisted to root by the package manager
    deps = [
        ${list}
    ],`;
        }
        let dtsStarlark = '';
        if (dtsSources.length) {
            dtsStarlark = `
    # ${pkg._dir} package declaration files (and declaration files in nested node_modules)
    srcs = [
        ${dtsSources.map(f => `"//:node_modules/${pkg._dir}/${f}",`).join('\n        ')}
    ],`;
        }
        let result = `load("@build_bazel_rules_nodejs//internal/npm_install:node_module_library.bzl", "node_module_library")

# Generated targets for npm package "${pkg._dir}"
${printJson(pkg)}

filegroup(
    name = "${pkg._name}__files",${srcsStarlark}
)

node_module_library(
    name = "${pkg._name}",
    # direct sources listed for strict deps support
    srcs = [":${pkg._name}__files"],${depsStarlark}
)

# ${pkg._name}__contents target is used as dep for main targets to prevent
# circular dependencies errors
node_module_library(
    name = "${pkg._name}__contents",
    srcs = [":${pkg._name}__files"],${namedSourcesStarlark}
)

# ${pkg._name}__typings is the subset of ${pkg._name}__contents that are declarations
node_module_library(
    name = "${pkg._name}__typings",${dtsStarlark}
)

`;
        let mainEntryPoint = resolvePkgMainFile(pkg);
        // add an `npm_umd_bundle` target to generate an UMD bundle if one does
        // not exists
        if (mainEntryPoint && !findFile(pkg, `${pkg._name}.umd.js`)) {
            result +=
                `load("@build_bazel_rules_nodejs//internal/npm_install:npm_umd_bundle.bzl", "npm_umd_bundle")

npm_umd_bundle(
    name = "${pkg._name}__umd",
    package_name = "${pkg._name}",
    entry_point = "//:node_modules/${pkg._dir}/${mainEntryPoint}",
    package = ":${pkg._name}",
)

`;
        }
        return result;
    }
    function _findExecutables(pkg) {
        const executables = new Map();
        // For root packages, transform the pkg.bin entries
        // into a new Map called _executables
        // NOTE: we do this only for non-empty bin paths
        if (isValidBinPath(pkg.bin)) {
            if (!pkg._isNested) {
                if (Array.isArray(pkg.bin)) {
                    if (pkg.bin.length == 1) {
                        executables.set(pkg._dir, cleanupBinPath(pkg.bin[0]));
                    }
                    else {
                        // should not happen, but ignore it if present
                    }
                }
                else if (typeof pkg.bin === 'string') {
                    executables.set(pkg._dir, cleanupBinPath(pkg.bin));
                }
                else if (typeof pkg.bin === 'object') {
                    for (let key in pkg.bin) {
                        if (isValidBinPathStringValue(pkg.bin[key])) {
                            executables.set(key, cleanupBinPath(pkg.bin[key]));
                        }
                    }
                }
            }
        }
        return executables;
    }
    // Handle additionalAttributes of format:
    // ```
    // "bazelBin": {
    //   "ngc-wrapped": {
    //     "additionalAttributes": {
    //       "configuration_env_vars": "[\"compile\"]"
    //   }
    // },
    // ```
    function additionalAttributes(pkg, name) {
        let additionalAttributes = '';
        if (pkg.bazelBin && pkg.bazelBin[name] && pkg.bazelBin[name].additionalAttributes) {
            const attrs = pkg.bazelBin[name].additionalAttributes;
            for (const attrName of Object.keys(attrs)) {
                const attrValue = attrs[attrName];
                additionalAttributes += `\n    ${attrName} = ${attrValue},`;
            }
        }
        return additionalAttributes;
    }
    /**
     * Given a pkg, return the skylark nodejs_binary targets for the package.
     */
    function printPackageBin(pkg) {
        let result = '';
        const executables = _findExecutables(pkg);
        if (executables.size) {
            result = `load("@build_bazel_rules_nodejs//:index.bzl", "nodejs_binary")

`;
            const data = [`//${pkg._dir}:${pkg._name}`];
            if (pkg._dynamicDependencies) {
                data.push(...pkg._dynamicDependencies);
            }
            for (const [name, path] of executables.entries()) {
                result += `# Wire up the \`bin\` entry \`${name}\`
nodejs_binary(
    name = "${name}",
    entry_point = "//:node_modules/${pkg._dir}/${path}",
    install_source_map_support = False,
    data = [${data.map(p => `"${p}"`).join(', ')}],${additionalAttributes(pkg, name)}
)

`;
            }
        }
        return result;
    }
    function printIndexBzl(pkg) {
        let result = '';
        const executables = _findExecutables(pkg);
        if (executables.size) {
            result = `load("@build_bazel_rules_nodejs//:index.bzl", "nodejs_binary", "npm_package_bin")

`;
            const data = [`@${WORKSPACE}//${pkg._dir}:${pkg._name}`];
            if (pkg._dynamicDependencies) {
                data.push(...pkg._dynamicDependencies);
            }
            for (const [name, path] of executables.entries()) {
                result = `${result}

# Generated helper macro to call ${name}
def ${name.replace(/-/g, '_')}(**kwargs):
    output_dir = kwargs.pop("output_dir", False)
    if "outs" in kwargs or output_dir:
        npm_package_bin(tool = "@${WORKSPACE}//${pkg._dir}/bin:${name}", output_dir = output_dir, **kwargs)
    else:
        nodejs_binary(
            entry_point = "@${WORKSPACE}//:node_modules/${pkg._dir}/${path}",
            install_source_map_support = False,
            data = [${data.map(p => `"${p}"`).join(', ')}] + kwargs.pop("data", []),${additionalAttributes(pkg, name)}
            **kwargs
        )
  `;
            }
        }
        return result;
    }
    /**
     * Given a scope, return the skylark `node_module_library` target for the scope.
     */
    function printScope(scope, pkgs) {
        pkgs = pkgs.filter(pkg => !pkg._isNested && pkg._dir.startsWith(`${scope}/`));
        let deps = [];
        pkgs.forEach(pkg => {
            deps = deps.concat(pkg._dependencies.filter(dep => !dep._isNested && !pkgs.includes(pkg)));
        });
        // filter out duplicate deps
        deps = [...pkgs, ...new Set(deps)];
        let srcsStarlark = '';
        if (deps.length) {
            const list = deps.map(dep => `"//${dep._dir}:${dep._name}__files",`).join('\n        ');
            srcsStarlark = `
    # direct sources listed for strict deps support
    srcs = [
        ${list}
    ],`;
        }
        let depsStarlark = '';
        if (deps.length) {
            const list = deps.map(dep => `"//${dep._dir}:${dep._name}__contents",`).join('\n        ');
            depsStarlark = `
    # flattened list of direct and transitive dependencies hoisted to root by the package manager
    deps = [
        ${list}
    ],`;
        }
        return `load("@build_bazel_rules_nodejs//internal/npm_install:node_module_library.bzl", "node_module_library")

# Generated target for npm scope ${scope}
node_module_library(
    name = "${scope}",${srcsStarlark}${depsStarlark}
)

`;
    }
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2VuZXJhdGVfYnVpbGRfZmlsZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL2ludGVybmFsL25wbV9pbnN0YWxsL2dlbmVyYXRlX2J1aWxkX2ZpbGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7O0lBQUE7Ozs7Ozs7Ozs7Ozs7OztPQWVHO0lBQ0g7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7T0FzQkc7SUFDSCxZQUFZLENBQUM7O0lBR2IseUJBQXlCO0lBQ3pCLDZCQUE2QjtJQUM3QixpQ0FBaUM7SUFFakMsU0FBUyxXQUFXLENBQUMsR0FBRyxDQUFRO1FBQzlCLElBQUksQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsY0FBYyxDQUFDO1lBQUUsT0FBTyxDQUFDLEtBQUssQ0FBQywwQkFBMEIsRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFDO0lBQ3JGLENBQUM7SUFFRCxNQUFNLGlCQUFpQixHQUFHOzs7Ozs7Q0FNekIsQ0FBQTtJQUVELE1BQU0sSUFBSSxHQUFHLE9BQU8sQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQ25DLE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMxQixNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDMUIsTUFBTSxvQkFBb0IsR0FBRyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDL0MsTUFBTSxjQUFjLEdBQUcsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQy9CLE1BQU0sY0FBYyxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ3pELE1BQU0sWUFBWSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLElBQUksQ0FBQyxDQUFDO0lBRWpELElBQUksT0FBTyxDQUFDLElBQUksS0FBSyxNQUFNLEVBQUU7UUFDM0IsSUFBSSxFQUFFLENBQUM7S0FDUjtJQUVEOzs7T0FHRztJQUNILFNBQVMsTUFBTSxDQUFDLENBQVM7UUFDdkIsSUFBSSxDQUFDLEVBQUUsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLEVBQUU7WUFDckIsTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUN4QixFQUFFLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDO1NBQ2pCO0lBQ0gsQ0FBQztJQUVEOzs7T0FHRztJQUNILFNBQVMsYUFBYSxDQUFDLENBQVMsRUFBRSxPQUFlO1FBQy9DLE1BQU0sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDeEIsRUFBRSxDQUFDLGFBQWEsQ0FBQyxDQUFDLEVBQUUsT0FBTyxDQUFDLENBQUM7SUFDL0IsQ0FBQztJQUVEOztPQUVHO0lBQ0gsU0FBUyxJQUFJO1FBQ1gsZ0VBQWdFO1FBQ2hFLE1BQU0sSUFBSSxHQUFHLFlBQVksRUFBRSxDQUFDO1FBRTVCLHVCQUF1QjtRQUN2QixtQkFBbUIsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUUxQiw0QkFBNEI7UUFDNUIsdUJBQXVCLENBQUMsSUFBSSxDQUFDLENBQUE7UUFFN0IsMkJBQTJCO1FBQzNCLGtCQUFrQixDQUFDLElBQUksQ0FBQyxDQUFBO0lBQzFCLENBQUM7SUFFRCxNQUFNLENBQUMsT0FBTyxHQUFHO1FBQ2YsSUFBSTtRQUNKLGVBQWU7UUFDZixzQkFBc0I7UUFDdEIsYUFBYTtLQUNkLENBQUM7SUFFRjs7T0FFRztJQUNILFNBQVMsa0JBQWtCLENBQUMsSUFBVztRQUNyQyxxQkFBcUIsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQTtRQUN6RCxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMseUJBQXlCLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztRQUNsRixVQUFVLEVBQUUsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyx1QkFBdUIsQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQztJQUN0RSxDQUFDO0lBRUQ7O09BRUc7SUFDSCxTQUFTLG1CQUFtQixDQUFDLElBQVc7UUFDdEMsTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFHLEVBQUUsQ0FBQztRQUMxQixJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUM7UUFDaEQsSUFBSSxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLHNCQUFzQixDQUFDLEdBQUcsRUFBRSxHQUFHLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQztJQUNqRSxDQUFDO0lBRUQ7O09BRUc7SUFDSCxTQUFTLGNBQWMsQ0FBQyxHQUFRO1FBQzlCLE1BQU0saUJBQWlCLEdBQUcsV0FBVyxDQUFDLHNDQUFzQyxDQUFDLENBQUM7UUFDOUUsR0FBRyxDQUFDLE1BQU0sR0FBRyxHQUFHLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRTtZQUNqQyxNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ3JDLE1BQU0sVUFBVSxHQUFHLFFBQVEsQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUMxQyxJQUFJLFVBQVUsS0FBSyxPQUFPLElBQUksVUFBVSxLQUFLLGFBQWEsRUFBRTtnQkFDMUQsMEVBQTBFO2dCQUMxRSwyRUFBMkU7Z0JBQzNFLHdFQUF3RTtnQkFDeEUsa0ZBQWtGO2dCQUNsRixtRUFBbUU7Z0JBQ25FLCtFQUErRTtnQkFDL0Usc0VBQXNFO2dCQUN0RSx5RkFBeUY7Z0JBQ3pGLGVBQWU7Z0JBQ2YsSUFBSSxDQUFDLGlCQUFpQixJQUFJLG9CQUFvQixFQUFFO29CQUM5QyxPQUFPLENBQUMsS0FBSyxDQUFDLGdCQUFnQixHQUFHLENBQUMsSUFBSSxXQUFXLFNBQVMsSUFBSSxTQUFTOzBCQUNyRCxJQUFJOzsrQkFFQyxDQUFDLENBQUM7b0JBQ3pCLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7aUJBQ2pCO3FCQUFNO29CQUNMLCtEQUErRDtvQkFDL0QsMkVBQTJFO29CQUMzRSxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFLElBQUksUUFBUSxFQUFFLENBQUMsQ0FBQztvQkFDcEUsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsY0FBYyxFQUFFLEdBQUcsQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLENBQUM7b0JBQ2hFLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLGNBQWMsRUFBRSxHQUFHLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDO29CQUNuRSxFQUFFLENBQUMsVUFBVSxDQUFDLE9BQU8sRUFBRSxPQUFPLENBQUMsQ0FBQztvQkFDaEMsT0FBTyxPQUFPLENBQUM7aUJBQ2hCO2FBQ0Y7WUFDRCxPQUFPLElBQUksQ0FBQztRQUNkLENBQUMsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVEOztPQUVHO0lBQ0gsU0FBUyxxQkFBcUIsQ0FBQyxJQUFXO1FBQ3hDLElBQUksZUFBZSxHQUFHLEVBQUUsQ0FBQztRQUN6QixJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFO1lBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQUU7Z0JBQzdCLGVBQWUsSUFBSSxxQkFBcUIsR0FBRyxDQUFDLElBQUksSUFBSSxDQUFDO0NBQ3JFLENBQUM7WUFDYSxDQUFDLENBQUMsQ0FBQTtRQUFBLENBQUMsQ0FBQyxDQUFDO1FBRWxCLElBQUksWUFBWSxHQUFHLEVBQUUsQ0FBQztRQUN0QixJQUFJLElBQUksQ0FBQyxNQUFNLEVBQUU7WUFDZixNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxHQUFHLENBQUMsSUFBSSxJQUFJLEdBQUcsQ0FBQyxLQUFLLFdBQVcsQ0FBQyxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQztZQUN4RixZQUFZLEdBQUc7OztVQUdULElBQUk7T0FDUCxDQUFDO1NBQ0w7UUFFRCxJQUFJLFlBQVksR0FBRyxFQUFFLENBQUM7UUFDdEIsSUFBSSxJQUFJLENBQUMsTUFBTSxFQUFFO1lBQ2YsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLE1BQU0sR0FBRyxDQUFDLElBQUksSUFBSSxHQUFHLENBQUMsS0FBSyxjQUFjLENBQUMsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7WUFDM0YsWUFBWSxHQUFHOzs7VUFHVCxJQUFJO09BQ1AsQ0FBQztTQUNMO1FBRUQsSUFBSSxTQUFTLEdBQUcsaUJBQWlCO1lBQzdCOzs7RUFHSixlQUFlOzs7Ozs7OzRCQU9XLFlBQVksR0FBRyxZQUFZOzs7Q0FHdEQsQ0FBQTtRQUVDLG9EQUFvRDtRQUNwRCxJQUFJO1lBQ0YsU0FBUyxJQUFJLEVBQUUsQ0FBQyxZQUFZLENBQUMsNEJBQTRCLEVBQUUsRUFBQyxRQUFRLEVBQUUsTUFBTSxFQUFDLENBQUMsQ0FBQztTQUNoRjtRQUFDLE9BQU8sQ0FBQyxFQUFFO1NBQ1g7UUFFRCxhQUFhLENBQUMsYUFBYSxFQUFFLFNBQVMsQ0FBQyxDQUFDO0lBQzFDLENBQUM7SUFFRDs7T0FFRztJQUNILFNBQVMseUJBQXlCLENBQUMsR0FBUTtRQUN6QyxJQUFJLFNBQVMsR0FBRyxZQUFZLENBQUMsR0FBRyxDQUFDLENBQUM7UUFFbEMsTUFBTSxZQUFZLEdBQUcsZUFBZSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQzFDLElBQUksWUFBWSxDQUFDLE1BQU0sRUFBRTtZQUN2QixhQUFhLENBQ1QsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUUsYUFBYSxDQUFDLEVBQUUsaUJBQWlCLEdBQUcsWUFBWSxDQUFDLENBQUM7U0FDeEY7UUFFRCxNQUFNLFNBQVMsR0FBRyxhQUFhLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDckMsSUFBSSxTQUFTLENBQUMsTUFBTSxFQUFFO1lBQ3BCLGFBQWEsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLFdBQVcsQ0FBQyxFQUFFLFNBQVMsQ0FBQyxDQUFDO1lBQ2pFLFNBQVMsR0FBRyxHQUFHLFNBQVM7OztDQUczQixDQUFDO1NBQ0M7UUFFRCxhQUFhLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxhQUFhLENBQUMsRUFBRSxpQkFBaUIsR0FBRyxTQUFTLENBQUMsQ0FBQztJQUN6RixDQUFDO0lBRUQ7O09BRUc7SUFDSCxTQUFTLHVCQUF1QixDQUFDLElBQVc7UUFDMUMsTUFBTSxVQUFVLEdBQWdCLEVBQUUsQ0FBQztRQUVuQyxLQUFLLE1BQU0sR0FBRyxJQUFJLElBQUksRUFBRTtZQUN0QixJQUFJLENBQUMsR0FBRyxDQUFDLGVBQWUsRUFBRTtnQkFDeEIsU0FBUzthQUNWO1lBRUQsS0FBSyxNQUFNLFNBQVMsSUFBSSxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxlQUFlLENBQUMsRUFBRTtnQkFDeEQseURBQXlEO2dCQUN6RCxJQUFJLFVBQVUsQ0FBQyxTQUFTLENBQUMsRUFBRTtvQkFDekIsT0FBTyxDQUFDLEtBQUssQ0FDVCxtQ0FBbUMsU0FBUyxvQkFBb0I7d0JBQ2hFLFdBQVcsR0FBRyxDQUFDLElBQUksSUFBSSxHQUFHLENBQUMsT0FBTyxzQkFBc0IsVUFBVSxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUMsQ0FBQztvQkFDckYsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztpQkFDakI7Z0JBRUQsc0JBQXNCLENBQUMsR0FBRyxFQUFFLFNBQVMsQ0FBQyxDQUFDO2dCQUV2QywyRUFBMkU7Z0JBQzNFLFVBQVUsQ0FBQyxTQUFTLENBQUMsR0FBRyxHQUFHLEdBQUcsQ0FBQyxJQUFJLElBQUksR0FBRyxDQUFDLE9BQU8sRUFBRSxDQUFDO2FBQ3REO1NBQ0Y7UUFFRCxrREFBa0Q7UUFDbEQsZ0NBQWdDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDO0lBQzVELENBQUM7SUFFRDs7T0FFRztJQUNILFNBQVMsc0JBQXNCLENBQUMsR0FBUSxFQUFFLFNBQWlCO1FBQ3pELElBQUksT0FBTyxHQUFHOzs7Ozs7Q0FNZixDQUFDO1FBRUEsTUFBTSxRQUFRLEdBQUcsR0FBRyxDQUFDLGVBQWUsQ0FBQyxTQUFTLENBQUMsQ0FBQyxRQUFRLENBQUM7UUFDekQsSUFBSSxDQUFDLFFBQVEsRUFBRTtZQUNiLE9BQU8sQ0FBQyxLQUFLLENBQ1QsMENBQTBDLEdBQUcsQ0FBQyxJQUFJLElBQUksR0FBRyxDQUFDLE9BQU8sSUFBSTtnQkFDckUsa0NBQWtDLFNBQVMsR0FBRyxDQUFDLENBQUM7WUFDcEQsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztTQUNqQjtRQUVELGtFQUFrRTtRQUNsRSx3RUFBd0U7UUFDeEUsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxhQUFhLEVBQUUsU0FBUyxDQUFDLENBQUM7UUFDdEUsTUFBTSxDQUFDLG1CQUFtQixDQUFDLENBQUM7UUFDNUIsR0FBRyxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLEVBQUU7WUFDeEIsSUFBSSxvQkFBb0IsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUU7Z0JBQ25DLHNDQUFzQztnQkFDdEMsT0FBTzthQUNSO1lBQ0QsSUFBSSxRQUFRLEdBQUcsSUFBSSxDQUFDLFFBQVEsQ0FBQyxRQUFRLEVBQUUsSUFBSSxDQUFDLENBQUM7WUFDN0MsSUFBSSxRQUFRLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxFQUFFO2dCQUM3QixzQ0FBc0M7Z0JBQ3RDLE9BQU87YUFDUjtZQUNELE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDckMsTUFBTSxVQUFVLEdBQUcsUUFBUSxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQzFDLDZGQUE2RjtZQUM3RixrQ0FBa0M7WUFDbEMsSUFBSSxVQUFVLEtBQUssUUFBUSxJQUFJLFVBQVUsS0FBSyxjQUFjLEVBQUU7Z0JBQzVELFFBQVEsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQzthQUN4RTtZQUNELE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLGNBQWMsRUFBRSxHQUFHLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxDQUFDO1lBQzVELE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLG1CQUFtQixFQUFFLFFBQVEsQ0FBQyxDQUFDO1lBQzVELE1BQU0sQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7WUFDM0IsRUFBRSxDQUFDLFlBQVksQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDN0IsQ0FBQyxDQUFDLENBQUM7UUFFSCwrRUFBK0U7UUFDL0UsNEVBQTRFO1FBQzVFLGlGQUFpRjtRQUNqRixzQ0FBc0M7UUFDdEMsSUFBSSxDQUFDLGdCQUFnQixDQUFDLEdBQUcsRUFBRSxRQUFRLENBQUMsRUFBRTtZQUNwQyxhQUFhLENBQ1QsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsbUJBQW1CLEVBQUUsYUFBYSxDQUFDLEVBQ25ELHNEQUFzRCxDQUFDLENBQUM7U0FDN0Q7UUFDRCxNQUFNLFNBQVMsR0FBRyxNQUFNLENBQUMsVUFBVSxDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQzlDLFNBQVMsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLFlBQVksQ0FBQyxjQUFjLEVBQUUsRUFBQyxRQUFRLEVBQUUsTUFBTSxFQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ3RFLGFBQWEsQ0FDVCxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxtQkFBbUIsRUFBRSx5QkFBeUIsQ0FBQyxFQUMvRCx5REFBeUQsU0FBUyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUM7UUFFeEYsT0FBTyxJQUFJLGVBQWUsU0FBUzs7O2tCQUduQixTQUFTOzBCQUNELFNBQVMsaUJBQWlCLFNBQVM7O0NBRTVELENBQUM7UUFFQSxhQUFhLENBQUMsV0FBVyxTQUFTLE1BQU0sRUFBRSxPQUFPLENBQUMsQ0FBQztJQUNyRCxDQUFDO0lBRUQ7O09BRUc7SUFDSCxTQUFTLGdDQUFnQyxDQUFDLFVBQW9CO1FBQzVELElBQUksT0FBTyxHQUFHO0NBQ2YsQ0FBQztRQUNBLFVBQVUsQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFDLEVBQUU7WUFDN0IsT0FBTyxJQUFJLG1CQUFtQixTQUFTLHFCQUFxQixTQUFTO0NBQ3hFLENBQUM7UUFDQSxDQUFDLENBQUMsQ0FBQztRQUNILE9BQU8sSUFBSTs7Q0FFWixDQUFDO1FBQ0EsVUFBVSxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMsRUFBRTtZQUM3QixPQUFPLElBQUksZUFBZSxTQUFTO0NBQ3RDLENBQUM7UUFDQSxDQUFDLENBQUMsQ0FBQztRQUVILGFBQWEsQ0FBQyxnQ0FBZ0MsRUFBRSxPQUFPLENBQUMsQ0FBQztJQUMzRCxDQUFDO0lBRUQ7O09BRUc7SUFDSCxTQUFTLHVCQUF1QixDQUFDLEtBQWEsRUFBRSxJQUFXO1FBQ3pELE1BQU0sU0FBUyxHQUFHLGlCQUFpQixHQUFHLFVBQVUsQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDOUQsYUFBYSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxhQUFhLENBQUMsRUFBRSxTQUFTLENBQUMsQ0FBQztJQUNsRSxDQUFDO0lBRUQ7O09BRUc7SUFDSCxTQUFTLE1BQU0sQ0FBQyxDQUFTO1FBQ3ZCLE9BQU8sRUFBRSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDO0lBQ3JELENBQUM7SUFFRDs7T0FFRztJQUNILFNBQVMsV0FBVyxDQUFDLENBQVM7UUFDNUIsT0FBTyxFQUFFLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsV0FBVyxFQUFFLENBQUM7SUFDMUQsQ0FBQztJQUVEOzs7T0FHRztJQUNILFNBQVMsU0FBUyxDQUFDLE9BQWUsRUFBRSxTQUFpQixFQUFFO1FBQ3JELE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRSxNQUFNLENBQUMsQ0FBQztRQUM3QyxJQUFJLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxFQUFFO1lBQ3JCLE9BQU8sRUFBRSxDQUFDO1NBQ1g7UUFDRCxPQUFPLEVBQUUsQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDO2FBQ3JCLE1BQU0sQ0FDSCxDQUFDLEtBQWUsRUFBRSxJQUFJLEVBQUUsRUFBRTtZQUN4QixNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLENBQUM7WUFDNUMsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsTUFBTSxFQUFFLElBQUksQ0FBQyxDQUFDO1lBQzlDLE1BQU0sY0FBYyxHQUFHLEVBQUUsQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUMsY0FBYyxFQUFFLENBQUM7WUFDL0QsSUFBSSxJQUFJLENBQUM7WUFDVCxJQUFJO2dCQUNGLElBQUksR0FBRyxFQUFFLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxDQUFDO2FBQzlCO1lBQUMsT0FBTyxDQUFDLEVBQUU7Z0JBQ1YsSUFBSSxjQUFjLEVBQUU7b0JBQ2xCLHNFQUFzRTtvQkFDdEUsdURBQXVEO29CQUN2RCxPQUFPLEtBQUssQ0FBQztpQkFDZDtnQkFDRCxNQUFNLENBQUMsQ0FBQzthQUNUO1lBQ0QsTUFBTSxXQUFXLEdBQUcsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQ3ZDLElBQUksV0FBVyxJQUFJLGNBQWMsRUFBRTtnQkFDakMsc0VBQXNFO2dCQUN0RSx5RUFBeUU7Z0JBQ3pFLDhEQUE4RDtnQkFDOUQsZ0VBQWdFO2dCQUNoRSx5REFBeUQ7Z0JBQ3pELGdEQUFnRDtnQkFDaEQsT0FBTyxLQUFLLENBQUM7YUFDZDtZQUNELE9BQU8sV0FBVyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxPQUFPLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUN6RixDQUFDLEVBQ0QsRUFBRSxDQUFDO1lBQ1AscUZBQXFGO1lBQ3JGLHNFQUFzRTthQUNyRSxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDckMsc0RBQXNEO1lBQ3RELHFDQUFxQzthQUNwQyxJQUFJLEVBQUUsQ0FBQztJQUNkLENBQUM7SUFFRDs7O09BR0c7SUFDSCxTQUFTLGdCQUFnQixDQUFDLEdBQVEsRUFBRSxRQUFnQjtRQUNsRCxLQUFLLE1BQU0sSUFBSSxJQUFJLEdBQUcsQ0FBQyxNQUFNLEVBQUU7WUFDN0IsZ0VBQWdFO1lBQ2hFLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUMsUUFBUSxFQUFFLElBQUksQ0FBQyxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQzNELElBQUksTUFBTSxLQUFLLFFBQVEsSUFBSSxNQUFNLEtBQUssY0FBYyxFQUFFO2dCQUNwRCxPQUFPLElBQUksQ0FBQzthQUNiO1NBQ0Y7UUFDRCxPQUFPLEtBQUssQ0FBQztJQUNmLENBQUM7SUFHRCxTQUFTLHNCQUFzQixDQUFDLElBQVcsRUFBRSxZQUFZLEdBQUcsWUFBWTtRQUN0RSxTQUFTLEtBQUssQ0FBQyxJQUFZLEVBQUUsQ0FBTTtZQUNqQyxpRkFBaUY7WUFDakYsSUFBSSxJQUFJLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxDQUFDLFdBQVcsVUFBVSxDQUFDO2dCQUFFLE9BQU8sSUFBSSxDQUFDO1lBRTdELE1BQU0sS0FBSyxHQUFHLFlBQVksQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDLENBQUM7WUFDMUMsSUFBSSxJQUFJLEtBQUssS0FBSztnQkFBRSxPQUFPLElBQUksQ0FBQztZQUVoQyx5QkFBeUI7WUFDekIsSUFBSSxLQUFLLElBQUksS0FBSyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsSUFBSSxJQUFJLENBQUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFO2dCQUMzRixPQUFPLElBQUksQ0FBQzthQUNiO1lBRUQsT0FBTyxLQUFLLENBQUM7UUFDZixDQUFDO1FBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRTtZQUNmLENBQUMsQ0FBQyxvQkFBb0I7Z0JBQ2xCLElBQUksQ0FBQyxNQUFNO2dCQUNILHNCQUFzQjtnQkFDdEIsc0VBQXNFO2dCQUN0RSxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLFdBQVc7b0JBQ3RELEtBQUssQ0FBQyxDQUFDLENBQUMsV0FBVyxFQUFFLENBQUMsQ0FBQyxDQUFDO3FCQUMvQixHQUFHLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxJQUFJLElBQUksR0FBRyxDQUFDLEtBQUssRUFBRSxDQUFDLENBQUM7UUFDcEQsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQ7O09BRUc7SUFDSCxTQUFTLFlBQVksQ0FBQyxDQUFDLEdBQUcsY0FBYztRQUN0QyxJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxFQUFFO1lBQ25CLE9BQU8sRUFBRSxDQUFDO1NBQ1g7UUFFRCxNQUFNLElBQUksR0FBVSxFQUFFLENBQUM7UUFFdkIsTUFBTSxPQUFPLEdBQUcsRUFBRSxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUVsQyxNQUFNLFFBQVEsR0FBRyxPQUFPO1lBQ0gsb0JBQW9CO2FBQ25CLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsQ0FBQztZQUNoQyxxREFBcUQ7WUFDckQsd0RBQXdEO2FBQ3ZELE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsQ0FBQzthQUMvQixHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7YUFDL0IsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFFbEQsUUFBUSxDQUFDLE9BQU8sQ0FDWixDQUFDLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxFQUFFLEdBQUcsWUFBWSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsRUFBRSxjQUFjLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUUxRixNQUFNLE1BQU0sR0FBRyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsQ0FBQzthQUNqQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7YUFDL0IsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDaEQsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBRW5ELHNCQUFzQixDQUFDLElBQUksQ0FBQyxDQUFDO1FBRTdCLE9BQU8sSUFBSSxDQUFDO0lBQ2QsQ0FBQztJQUVEOztPQUVHO0lBQ0gsU0FBUyxVQUFVO1FBQ2pCLE1BQU0sQ0FBQyxHQUFHLGNBQWMsQ0FBQztRQUN6QixJQUFJLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxFQUFFO1lBQ25CLE9BQU8sRUFBRSxDQUFDO1NBQ1g7UUFFRCxNQUFNLE9BQU8sR0FBRyxFQUFFLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBRWxDLE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxDQUFDO2FBQ2pDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQzthQUMvQixNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUM7YUFDM0IsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxpQkFBaUIsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBRS9ELE9BQU8sTUFBTSxDQUFDO0lBQ2hCLENBQUM7SUFFRDs7OztPQUlHO0lBQ0gsU0FBUyxZQUFZLENBQUMsQ0FBUztRQUM3Qiw4Q0FBOEM7UUFDOUMsTUFBTSxXQUFXLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxFQUFFLGNBQWMsQ0FBQyxDQUFDO1FBQ3ZELE1BQU0sR0FBRyxHQUFHLE1BQU0sQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsWUFBWSxDQUFDLFdBQVcsRUFBRSxFQUFDLFFBQVEsRUFBRSxNQUFNLEVBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUM5RCxFQUFDLE9BQU8sRUFBRSxPQUFPLEVBQUMsQ0FBQztRQUVyRCxrREFBa0Q7UUFDbEQsZ0NBQWdDO1FBQ2hDLEdBQUcsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxpQkFBaUIsRUFBRSxFQUFFLENBQUMsQ0FBQztRQUU1QyxrREFBa0Q7UUFDbEQsR0FBRyxDQUFDLEtBQUssR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQztRQUV0QyxpRUFBaUU7UUFDakUsNENBQTRDO1FBQzVDLEdBQUcsQ0FBQyxXQUFXLEdBQUcsR0FBRyxDQUFDLElBQUksSUFBSSxHQUFHLEdBQUcsQ0FBQyxJQUFJLElBQUksR0FBRyxDQUFDLEtBQUssRUFBRSxDQUFDO1FBRXpELHdEQUF3RDtRQUN4RCxHQUFHLENBQUMsU0FBUyxHQUFHLGtCQUFrQixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUUzQyxzREFBc0Q7UUFDdEQsR0FBRyxDQUFDLE1BQU0sR0FBRyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFFMUIsNkNBQTZDO1FBQzdDLDJEQUEyRDtRQUMzRCxHQUFHLENBQUMsYUFBYSxHQUFHLEVBQUUsQ0FBQztRQUV2Qiw4REFBOEQ7UUFDOUQsZ0VBQWdFO1FBQ2hFLDREQUE0RDtRQUM1RCxjQUFjLENBQUMsR0FBRyxDQUFDLENBQUM7UUFFcEIsT0FBTyxHQUFHLENBQUM7SUFDYixDQUFDO0lBRUQ7O09BRUc7SUFDSCxTQUFTLGNBQWMsQ0FBQyxLQUFVO1FBQ2hDLE9BQU8seUJBQXlCLENBQUMsS0FBSyxDQUFDLElBQUksMEJBQTBCLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDL0UsQ0FBQztJQUVEOztPQUVHO0lBQ0gsU0FBUyx5QkFBeUIsQ0FBQyxLQUFVO1FBQzNDLE9BQU8sT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLEtBQUssS0FBSyxFQUFFLENBQUM7SUFDbkQsQ0FBQztJQUVEOzs7OztPQUtHO0lBQ0gsU0FBUywwQkFBMEIsQ0FBQyxLQUFrQjtRQUNwRCxtREFBbUQ7UUFDbkQsT0FBTyxLQUFLLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUTtZQUNyQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsY0FBYyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQztJQUNsRixDQUFDO0lBRUQ7Ozs7OztPQU1HO0lBQ0gsU0FBUyxjQUFjLENBQUMsQ0FBUztRQUMvQixDQUFDLEdBQUcsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsR0FBRyxDQUFDLENBQUM7UUFDMUIsSUFBSSxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRTtZQUN6QixDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztTQUNoQjtRQUNELE9BQU8sQ0FBQyxDQUFDO0lBQ1gsQ0FBQztJQUVEOzs7OztPQUtHO0lBQ0gsU0FBUyxxQkFBcUIsQ0FBQyxDQUFTO1FBQ3RDLENBQUMsR0FBRyxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQztRQUMxQixJQUFJLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFO1lBQ3pCLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDO1NBQ2hCO1FBQ0QsSUFBSSxDQUFDLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxFQUFFO1lBQ25CLENBQUMsSUFBSSxVQUFVLENBQUM7U0FDakI7UUFDRCxPQUFPLENBQUMsQ0FBQztJQUNYLENBQUM7SUFFRDs7Ozs7OztPQU9HO0lBQ0gsU0FBUyxhQUFhLENBQUMsR0FBUSxFQUFFLElBQVk7UUFDM0MsTUFBTSxTQUFTLEdBQUcscUJBQXFCLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDOUMsbUNBQW1DO1FBQ25DLE1BQU0sU0FBUyxHQUFHLFFBQVEsQ0FBQyxHQUFHLEVBQUUsU0FBUyxDQUFDLElBQUksUUFBUSxDQUFDLEdBQUcsRUFBRSxHQUFHLFNBQVMsS0FBSyxDQUFDLENBQUM7UUFDL0UsSUFBSSxDQUFDLFNBQVMsRUFBRTtZQUNkLG1FQUFtRTtZQUNuRSxrQkFBa0I7WUFDbEIsNkVBQTZFO1lBQzdFLGlFQUFpRTtZQUNqRSxXQUFXLENBQ1AsMkNBQTJDLFNBQVMseUJBQXlCLEdBQUcsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDO1NBQy9GO1FBQ0QsT0FBTyxTQUFTLENBQUM7SUFDbkIsQ0FBQztJQUVEOzs7Ozs7T0FNRztJQUNILFNBQVMsZUFBZSxDQUFDLEdBQVEsRUFBRSxZQUFvQjtRQUNyRCxNQUFNLGNBQWMsR0FBRyxHQUFHLENBQUMsWUFBWSxDQUFDLENBQUM7UUFFekMsSUFBSSxjQUFjLEVBQUU7WUFDbEIsSUFBSSxPQUFPLGNBQWMsS0FBSyxRQUFRLEVBQUU7Z0JBQ3RDLE9BQU8sYUFBYSxDQUFDLEdBQUcsRUFBRSxjQUFjLENBQUMsQ0FBQTthQUUxQztpQkFBTSxJQUFJLE9BQU8sY0FBYyxLQUFLLFFBQVEsSUFBSSxZQUFZLEtBQUssU0FBUyxFQUFFO2dCQUMzRSwyQ0FBMkM7Z0JBQzNDLDJGQUEyRjtnQkFDM0YsTUFBTSxlQUFlLEdBQUcsY0FBYyxDQUFDLFVBQVUsQ0FBQyxJQUFJLGNBQWMsQ0FBQyxZQUFZLENBQUMsQ0FBQztnQkFDbkYsSUFBSSxlQUFlLEVBQUU7b0JBQ25CLE9BQU8sYUFBYSxDQUFDLEdBQUcsRUFBRSxlQUFlLENBQUMsQ0FBQTtpQkFDM0M7YUFDRjtTQUNGO0lBQ0gsQ0FBQztJQUVEOzs7OztPQUtHO0lBQ0gsU0FBUyxrQkFBa0IsQ0FBQyxHQUFRO1FBQ2xDLDZDQUE2QztRQUM3QywrREFBK0Q7UUFDL0QsRUFBRTtRQUNGLCtGQUErRjtRQUMvRixTQUFTO1FBQ1QsTUFBTSxhQUFhLEdBQUcsQ0FBQyxTQUFTLEVBQUUsUUFBUSxFQUFFLE1BQU0sQ0FBQyxDQUFBO1FBRS9DLEtBQUssTUFBTSxRQUFRLElBQUksYUFBYSxFQUFFO1lBQ3hDLE1BQU0sZ0JBQWdCLEdBQUcsZUFBZSxDQUFDLEdBQUcsRUFBRSxRQUFRLENBQUMsQ0FBQztZQUN4RCxJQUFJLGdCQUFnQixFQUFFO2dCQUNwQixPQUFPLGdCQUFnQixDQUFDO2FBQ3pCO1NBQ0Y7UUFFRCwyREFBMkQ7UUFDM0Qsc0RBQXNEO1FBQ3RELE1BQU0sY0FBYyxHQUFHLGFBQWEsQ0FBQyxHQUFHLEVBQUUsVUFBVSxDQUFDLENBQUM7UUFDdEQsSUFBSSxjQUFjLEVBQUU7WUFDbEIsT0FBTyxjQUFjLENBQUE7U0FDdEI7UUFFRCxNQUFNLG1CQUFtQixHQUFHLGFBQWEsQ0FBQyxHQUFHLEVBQUUsR0FBRyxHQUFHLENBQUMsS0FBSyxLQUFLLENBQUMsQ0FBQztRQUNsRSxJQUFJLG1CQUFtQixFQUFFO1lBQ3ZCLE9BQU8sbUJBQW1CLENBQUM7U0FDNUI7UUFFRCxrREFBa0Q7UUFDbEQsV0FBVyxDQUFDLDhDQUE4QyxHQUFHLENBQUMsS0FBSyxFQUFFLENBQUMsQ0FBQztRQUV2RSxzRUFBc0U7UUFDdEUsT0FBTyxTQUFTLENBQUM7SUFDbkIsQ0FBQztJQU9EOzs7T0FHRztJQUNILFNBQVMsc0JBQXNCLENBQUMsR0FBUSxFQUFFLEdBQVEsRUFBRSxPQUF5QjtRQUMzRSxJQUFJLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFO1lBQ3pDLHNCQUFzQjtZQUN0QixPQUFPO1NBQ1I7UUFDRCxHQUFHLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUM1QixNQUFNLFFBQVEsR0FBRyxVQUFTLFVBQXVCLEVBQUUsUUFBaUIsRUFBRSxPQUFlO1lBQ25GLE1BQU0sQ0FBQyxJQUFJLENBQUMsVUFBVSxJQUFJLEVBQUUsQ0FBQztpQkFDeEIsR0FBRyxDQUFDLFNBQVMsQ0FBQyxFQUFFO2dCQUNmLG1DQUFtQztnQkFDbkMsTUFBTSxXQUFXLEdBQUcsR0FBRyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7Z0JBQ3hDLE9BQU8sV0FBVyxDQUFDLE1BQU0sRUFBRTtvQkFDekIsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxXQUFXLEVBQUUsY0FBYyxFQUFFLFNBQVMsQ0FBQyxDQUFDO29CQUN6RSxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLEVBQUU7d0JBQ3RCLE9BQU8sT0FBTyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztxQkFDM0I7b0JBQ0QsV0FBVyxDQUFDLEdBQUcsRUFBRSxDQUFDO2lCQUNuQjtnQkFDRCxpQ0FBaUM7Z0JBQ2pDLElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsRUFBRTtvQkFDMUIsT0FBTyxPQUFPLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDO2lCQUMvQjtnQkFDRCx1QkFBdUI7Z0JBQ3ZCLElBQUksUUFBUSxFQUFFO29CQUNaLE9BQU8sQ0FBQyxLQUFLLENBQUMsa0JBQWtCLE9BQU8sS0FBSyxTQUFTLFNBQVMsR0FBRyxDQUFDLElBQUksR0FBRyxDQUFDLENBQUM7b0JBQzNFLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7aUJBQ2pCO2dCQUNELE9BQU8sSUFBSSxDQUFDO1lBQ2QsQ0FBQyxDQUFDO2lCQUNELE1BQU0sQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUM7aUJBQ3BCLE9BQU8sQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLHNCQUFzQixDQUFDLEdBQUcsRUFBRSxHQUFJLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQztRQUNsRSxDQUFDLENBQUM7UUFDRiw4REFBOEQ7UUFDOUQsaUVBQWlFO1FBQ2pFLHdEQUF3RDtRQUN4RCwrQ0FBK0M7UUFDL0MsSUFBSSxHQUFHLENBQUMsWUFBWSxJQUFJLEdBQUcsQ0FBQyxvQkFBb0IsRUFBRTtZQUNoRCxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsRUFBRTtnQkFDMUQsT0FBTyxHQUFHLENBQUMsWUFBWSxDQUFDLFdBQVcsQ0FBQyxDQUFDO1lBQ3ZDLENBQUMsQ0FBQyxDQUFDO1NBQ0o7UUFFRCxRQUFRLENBQUMsR0FBRyxDQUFDLFlBQVksRUFBRSxJQUFJLEVBQUUsWUFBWSxDQUFDLENBQUM7UUFDL0MsUUFBUSxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsRUFBRSxJQUFJLEVBQUUsaUJBQWlCLENBQUMsQ0FBQztRQUN4RCw2REFBNkQ7UUFDN0QsaUVBQWlFO1FBQ2pFLGdFQUFnRTtRQUNoRSxrREFBa0Q7UUFDbEQsK0RBQStEO1FBQy9ELDBEQUEwRDtRQUMxRCxnRUFBZ0U7UUFDaEUsNERBQTREO1FBQzVELDJDQUEyQztRQUMzQyxRQUFRLENBQUMsR0FBRyxDQUFDLG9CQUFvQixFQUFFLEtBQUssRUFBRSxxQkFBcUIsQ0FBQyxDQUFDO0lBQ25FLENBQUM7SUFFRDs7O09BR0c7SUFDSCxTQUFTLFNBQVMsQ0FBQyxHQUFRO1FBQ3pCLDBFQUEwRTtRQUMxRSx3QkFBd0I7UUFDeEIsTUFBTSxNQUFNLHFCQUFZLEdBQUcsQ0FBQyxDQUFDO1FBQzdCLE1BQU0sQ0FBQyxhQUFhLEdBQUcsR0FBRyxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDOUQsT0FBTyxNQUFNLENBQUMsTUFBTSxDQUFDO1FBQ3JCLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxNQUFNLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3pGLENBQUM7SUFFRDs7Ozs7O09BTUc7SUFDSCxTQUFTLFdBQVcsQ0FBQyxLQUFlLEVBQUUsT0FBaUIsRUFBRTtRQUN2RCxJQUFJLElBQUksQ0FBQyxNQUFNLEVBQUU7WUFDZixNQUFNLFdBQVcsR0FBRyxJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1lBQ3RDLEtBQUssR0FBRyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFO2dCQUN2QixvREFBb0Q7Z0JBQ3BELElBQUksV0FBVyxJQUFJLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7b0JBQUUsT0FBTyxJQUFJLENBQUM7Z0JBQ2pELHVCQUF1QjtnQkFDdkIsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDLFdBQVcsRUFBRSxDQUFDO2dCQUMzQixLQUFLLE1BQU0sQ0FBQyxJQUFJLElBQUksRUFBRTtvQkFDcEIsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsV0FBVyxFQUFFLENBQUMsRUFBRTt3QkFDckMsT0FBTyxJQUFJLENBQUM7cUJBQ2I7aUJBQ0Y7Z0JBQ0QsT0FBTyxLQUFLLENBQUM7WUFDZixDQUFDLENBQUMsQ0FBQTtTQUNIO1FBQ0Qsd0RBQXdEO1FBQ3hELE9BQU8sS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsRUFBRTtZQUN6QixNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQ3JELElBQUksVUFBVSxLQUFLLFFBQVEsSUFBSSxVQUFVLEtBQUssY0FBYyxFQUFFO2dCQUM1RCxPQUFPLEtBQUssQ0FBQzthQUNkO1lBQ0QsT0FBTyxJQUFJLENBQUM7UUFDZCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRDs7OztPQUlHO0lBQ0gsU0FBUyxjQUFjLENBQUMsR0FBUTtRQUM5QixNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDaEMsSUFBSSxHQUFHLENBQUMsR0FBRyxDQUFDLGlCQUFpQixDQUFDLEVBQUU7WUFDOUIsb0VBQW9FO1lBQ3BFLHdEQUF3RDtZQUN4RCxPQUFPLElBQUksQ0FBQztTQUNiO1FBQ0QsTUFBTSxXQUFXLEdBQUcsbUJBQW1CLENBQUM7UUFDeEMsT0FBTyxHQUFHLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFO1lBQzlCLElBQUksV0FBVyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRTtnQkFDMUIsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxXQUFXLEVBQUUsT0FBTyxDQUFDLENBQUM7Z0JBQ25ELElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsRUFBRTtvQkFDcEIsT0FBTyxJQUFJLENBQUM7aUJBQ2I7YUFDRjtZQUNELE9BQU8sS0FBSyxDQUFDO1FBQ2YsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQ7OztPQUdHO0lBQ0gsU0FBUyxlQUFlLENBQUMsR0FBUTtRQUMvQixPQUFPLGNBQWMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBQ3hCLFdBQVcsQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLENBQUMsU0FBUyxFQUFFLGVBQWUsRUFBRSxlQUFlLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDeEUsRUFBRSxDQUFDO0lBQ1QsQ0FBQztJQUVEOztPQUVHO0lBQ0gsU0FBUyxRQUFRLENBQUMsR0FBUSxFQUFFLENBQVM7UUFDbkMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDLFdBQVcsRUFBRSxDQUFDO1FBQzNCLEtBQUssTUFBTSxDQUFDLElBQUksR0FBRyxDQUFDLE1BQU0sRUFBRTtZQUMxQixJQUFJLENBQUMsQ0FBQyxXQUFXLEVBQUUsS0FBSyxFQUFFLEVBQUU7Z0JBQzFCLE9BQU8sQ0FBQyxDQUFDO2FBQ1Y7U0FDRjtRQUNELE9BQU8sU0FBUyxDQUFDO0lBQ25CLENBQUM7SUFFRDs7T0FFRztJQUNILFNBQVMsWUFBWSxDQUFDLEdBQVE7UUFDNUIsTUFBTSxPQUFPLEdBQUcsV0FBVyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsY0FBYyxDQUFDLENBQUM7UUFDeEQsTUFBTSxVQUFVLEdBQUcsV0FBVyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO1FBQ3RELGlHQUFpRztRQUNqRyxhQUFhO1FBQ2IsTUFBTSxZQUFZLEdBQUcsZUFBZSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQzFDLE1BQU0sSUFBSSxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxLQUFLLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDO1FBRTFGLElBQUksb0JBQW9CLEdBQUcsRUFBRSxDQUFDO1FBQzlCLElBQUksWUFBWSxDQUFDLE1BQU0sRUFBRTtZQUN2QixvQkFBb0IsR0FBRzs7O1VBR2pCLFlBQVksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFTLEVBQUUsRUFBRSxDQUFDLG9CQUFvQixHQUFHLENBQUMsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQztPQUM1RixDQUFDO1NBQ0w7UUFFRCxJQUFJLFlBQVksR0FBRyxFQUFFLENBQUM7UUFDdEIsSUFBSSxPQUFPLENBQUMsTUFBTSxFQUFFO1lBQ2xCLFlBQVksR0FBRztRQUNYLEdBQUcsQ0FBQyxJQUFJOztVQUVOLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFTLEVBQUUsRUFBRSxDQUFDLG9CQUFvQixHQUFHLENBQUMsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQztPQUN2RixDQUFDO1NBQ0w7UUFFRCxJQUFJLFlBQVksR0FBRyxFQUFFLENBQUM7UUFDdEIsSUFBSSxJQUFJLENBQUMsTUFBTSxFQUFFO1lBQ2YsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLE1BQU0sR0FBRyxDQUFDLElBQUksSUFBSSxHQUFHLENBQUMsS0FBSyxjQUFjLENBQUMsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7WUFDM0YsWUFBWSxHQUFHOzs7VUFHVCxJQUFJO09BQ1AsQ0FBQztTQUNMO1FBRUQsSUFBSSxXQUFXLEdBQUcsRUFBRSxDQUFDO1FBQ3JCLElBQUksVUFBVSxDQUFDLE1BQU0sRUFBRTtZQUNyQixXQUFXLEdBQUc7UUFDVixHQUFHLENBQUMsSUFBSTs7VUFFTixVQUFVLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsb0JBQW9CLEdBQUcsQ0FBQyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDO09BQ2hGLENBQUM7U0FDTDtRQUVELElBQUksTUFBTSxHQUNOOzt1Q0FFaUMsR0FBRyxDQUFDLElBQUk7RUFDN0MsU0FBUyxDQUFDLEdBQUcsQ0FBQzs7O2NBR0YsR0FBRyxDQUFDLEtBQUssWUFBWSxZQUFZOzs7O2NBSWpDLEdBQUcsQ0FBQyxLQUFLOztnQkFFUCxHQUFHLENBQUMsS0FBSyxhQUFhLFlBQVk7OztJQUc5QyxHQUFHLENBQUMsS0FBSzs7O2NBR0MsR0FBRyxDQUFDLEtBQUs7Z0JBQ1AsR0FBRyxDQUFDLEtBQUssYUFBYSxvQkFBb0I7OztJQUd0RCxHQUFHLENBQUMsS0FBSyw4QkFBOEIsR0FBRyxDQUFDLEtBQUs7O2NBRXRDLEdBQUcsQ0FBQyxLQUFLLGNBQWMsV0FBVzs7O0NBRy9DLENBQUM7UUFFQSxJQUFJLGNBQWMsR0FBRyxrQkFBa0IsQ0FBQyxHQUFHLENBQUMsQ0FBQTtRQUU1Qyx1RUFBdUU7UUFDdkUsYUFBYTtRQUNiLElBQUksY0FBYyxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsRUFBRSxHQUFHLEdBQUcsQ0FBQyxLQUFLLFNBQVMsQ0FBQyxFQUFFO1lBQzNELE1BQU07Z0JBQ0Y7OztjQUdNLEdBQUcsQ0FBQyxLQUFLO3NCQUNELEdBQUcsQ0FBQyxLQUFLO3FDQUNNLEdBQUcsQ0FBQyxJQUFJLElBQUksY0FBYztrQkFDN0MsR0FBRyxDQUFDLEtBQUs7OztDQUcxQixDQUFDO1NBQ0M7UUFFRCxPQUFPLE1BQU0sQ0FBQztJQUNoQixDQUFDO0lBRUQsU0FBUyxnQkFBZ0IsQ0FBQyxHQUFRO1FBQ2hDLE1BQU0sV0FBVyxHQUFHLElBQUksR0FBRyxFQUFFLENBQUM7UUFFOUIsbURBQW1EO1FBQ25ELHFDQUFxQztRQUNyQyxnREFBZ0Q7UUFDaEQsSUFBSSxjQUFjLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFO1lBQzNCLElBQUksQ0FBQyxHQUFHLENBQUMsU0FBUyxFQUFFO2dCQUNsQixJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFO29CQUMxQixJQUFJLEdBQUcsQ0FBQyxHQUFHLENBQUMsTUFBTSxJQUFJLENBQUMsRUFBRTt3QkFDdkIsV0FBVyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLGNBQWMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztxQkFDdkQ7eUJBQU07d0JBQ0wsOENBQThDO3FCQUMvQztpQkFDRjtxQkFBTSxJQUFJLE9BQU8sR0FBRyxDQUFDLEdBQUcsS0FBSyxRQUFRLEVBQUU7b0JBQ3RDLFdBQVcsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksRUFBRSxjQUFjLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7aUJBQ3BEO3FCQUFNLElBQUksT0FBTyxHQUFHLENBQUMsR0FBRyxLQUFLLFFBQVEsRUFBRTtvQkFDdEMsS0FBSyxJQUFJLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFO3dCQUN2QixJQUFJLHlCQUF5QixDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRTs0QkFDM0MsV0FBVyxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsY0FBYyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO3lCQUNwRDtxQkFDRjtpQkFDRjthQUNGO1NBQ0Y7UUFFRCxPQUFPLFdBQVcsQ0FBQztJQUNyQixDQUFDO0lBRUQseUNBQXlDO0lBQ3pDLE1BQU07SUFDTixnQkFBZ0I7SUFDaEIscUJBQXFCO0lBQ3JCLGdDQUFnQztJQUNoQyxrREFBa0Q7SUFDbEQsTUFBTTtJQUNOLEtBQUs7SUFDTCxNQUFNO0lBQ04sU0FBUyxvQkFBb0IsQ0FBQyxHQUFRLEVBQUUsSUFBWTtRQUNsRCxJQUFJLG9CQUFvQixHQUFHLEVBQUUsQ0FBQztRQUM5QixJQUFJLEdBQUcsQ0FBQyxRQUFRLElBQUksR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsSUFBSSxHQUFHLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLG9CQUFvQixFQUFFO1lBQ2pGLE1BQU0sS0FBSyxHQUFHLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsb0JBQW9CLENBQUM7WUFDdEQsS0FBSyxNQUFNLFFBQVEsSUFBSSxNQUFNLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFO2dCQUN6QyxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUM7Z0JBQ2xDLG9CQUFvQixJQUFJLFNBQVMsUUFBUSxNQUFNLFNBQVMsR0FBRyxDQUFDO2FBQzdEO1NBQ0Y7UUFDRCxPQUFPLG9CQUFvQixDQUFDO0lBQzlCLENBQUM7SUFFRDs7T0FFRztJQUNILFNBQVMsZUFBZSxDQUFDLEdBQVE7UUFDL0IsSUFBSSxNQUFNLEdBQUcsRUFBRSxDQUFDO1FBQ2hCLE1BQU0sV0FBVyxHQUFHLGdCQUFnQixDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQzFDLElBQUksV0FBVyxDQUFDLElBQUksRUFBRTtZQUNwQixNQUFNLEdBQUc7O0NBRVosQ0FBQztZQUNFLE1BQU0sSUFBSSxHQUFHLENBQUMsS0FBSyxHQUFHLENBQUMsSUFBSSxJQUFJLEdBQUcsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDO1lBQzVDLElBQUksR0FBRyxDQUFDLG9CQUFvQixFQUFFO2dCQUM1QixJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsR0FBRyxDQUFDLG9CQUFvQixDQUFDLENBQUM7YUFDeEM7WUFFRCxLQUFLLE1BQU0sQ0FBQyxJQUFJLEVBQUUsSUFBSSxDQUFDLElBQUksV0FBVyxDQUFDLE9BQU8sRUFBRSxFQUFFO2dCQUNoRCxNQUFNLElBQUksaUNBQWlDLElBQUk7O2NBRXZDLElBQUk7cUNBQ21CLEdBQUcsQ0FBQyxJQUFJLElBQUksSUFBSTs7Y0FFdkMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssb0JBQW9CLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQzs7O0NBR25GLENBQUM7YUFDRztTQUNGO1FBRUQsT0FBTyxNQUFNLENBQUM7SUFDaEIsQ0FBQztJQUVELFNBQVMsYUFBYSxDQUFDLEdBQVE7UUFDN0IsSUFBSSxNQUFNLEdBQUcsRUFBRSxDQUFDO1FBQ2hCLE1BQU0sV0FBVyxHQUFHLGdCQUFnQixDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQzFDLElBQUksV0FBVyxDQUFDLElBQUksRUFBRTtZQUNwQixNQUFNLEdBQUc7O0NBRVosQ0FBQztZQUNFLE1BQU0sSUFBSSxHQUFHLENBQUMsSUFBSSxTQUFTLEtBQUssR0FBRyxDQUFDLElBQUksSUFBSSxHQUFHLENBQUMsS0FBSyxFQUFFLENBQUMsQ0FBQztZQUN6RCxJQUFJLEdBQUcsQ0FBQyxvQkFBb0IsRUFBRTtnQkFDNUIsSUFBSSxDQUFDLElBQUksQ0FBQyxHQUFHLEdBQUcsQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO2FBQ3hDO1lBRUQsS0FBSyxNQUFNLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJLFdBQVcsQ0FBQyxPQUFPLEVBQUUsRUFBRTtnQkFDaEQsTUFBTSxHQUFHLEdBQUcsTUFBTTs7bUNBRVcsSUFBSTtNQUNqQyxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxHQUFHLENBQUM7OzttQ0FHTSxTQUFTLEtBQUssR0FBRyxDQUFDLElBQUksUUFDL0MsSUFBSTs7OzhCQUdnQixTQUFTLG1CQUFtQixHQUFHLENBQUMsSUFBSSxJQUFJLElBQUk7O3NCQUVwRCxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsOEJBQzlDLG9CQUFvQixDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUM7OztHQUd0QyxDQUFDO2FBQ0M7U0FDRjtRQUNELE9BQU8sTUFBTSxDQUFDO0lBQ2hCLENBQUM7SUFVRDs7T0FFRztJQUNILFNBQVMsVUFBVSxDQUFDLEtBQWEsRUFBRSxJQUFXO1FBQzVDLElBQUksR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsU0FBUyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLEdBQUcsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDO1FBQzlFLElBQUksSUFBSSxHQUFVLEVBQUUsQ0FBQztRQUNyQixJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFO1lBQ2pCLElBQUksR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsU0FBUyxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDN0YsQ0FBQyxDQUFDLENBQUM7UUFDSCw0QkFBNEI7UUFDNUIsSUFBSSxHQUFHLENBQUMsR0FBRyxJQUFJLEVBQUUsR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO1FBRW5DLElBQUksWUFBWSxHQUFHLEVBQUUsQ0FBQztRQUN0QixJQUFJLElBQUksQ0FBQyxNQUFNLEVBQUU7WUFDZixNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsTUFBTSxHQUFHLENBQUMsSUFBSSxJQUFJLEdBQUcsQ0FBQyxLQUFLLFdBQVcsQ0FBQyxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQztZQUN4RixZQUFZLEdBQUc7OztVQUdULElBQUk7T0FDUCxDQUFDO1NBQ0w7UUFFRCxJQUFJLFlBQVksR0FBRyxFQUFFLENBQUM7UUFDdEIsSUFBSSxJQUFJLENBQUMsTUFBTSxFQUFFO1lBQ2YsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLE1BQU0sR0FBRyxDQUFDLElBQUksSUFBSSxHQUFHLENBQUMsS0FBSyxjQUFjLENBQUMsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7WUFDM0YsWUFBWSxHQUFHOzs7VUFHVCxJQUFJO09BQ1AsQ0FBQztTQUNMO1FBRUQsT0FBTzs7bUNBRTBCLEtBQUs7O2NBRTFCLEtBQUssS0FBSyxZQUFZLEdBQUcsWUFBWTs7O0NBR2xELENBQUM7SUFDRixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBAbGljZW5zZVxuICogQ29weXJpZ2h0IDIwMTcgVGhlIEJhemVsIEF1dGhvcnMuIEFsbCByaWdodHMgcmVzZXJ2ZWQuXG4gKlxuICogTGljZW5zZWQgdW5kZXIgdGhlIEFwYWNoZSBMaWNlbnNlLCBWZXJzaW9uIDIuMCAodGhlIFwiTGljZW5zZVwiKTtcbiAqIHlvdSBtYXkgbm90IHVzZSB0aGlzIGZpbGUgZXhjZXB0IGluIGNvbXBsaWFuY2Ugd2l0aCB0aGUgTGljZW5zZS5cbiAqXG4gKiBZb3UgbWF5IG9idGFpbiBhIGNvcHkgb2YgdGhlIExpY2Vuc2UgYXRcbiAqICAgICBodHRwOi8vd3d3LmFwYWNoZS5vcmcvbGljZW5zZXMvTElDRU5TRS0yLjBcbiAqXG4gKiBVbmxlc3MgcmVxdWlyZWQgYnkgYXBwbGljYWJsZSBsYXcgb3IgYWdyZWVkIHRvIGluIHdyaXRpbmcsIHNvZnR3YXJlXG4gKiBkaXN0cmlidXRlZCB1bmRlciB0aGUgTGljZW5zZSBpcyBkaXN0cmlidXRlZCBvbiBhbiBcIkFTIElTXCIgQkFTSVMsXG4gKiBXSVRIT1VUIFdBUlJBTlRJRVMgT1IgQ09ORElUSU9OUyBPRiBBTlkgS0lORCwgZWl0aGVyIGV4cHJlc3Mgb3IgaW1wbGllZC5cbiAqIFNlZSB0aGUgTGljZW5zZSBmb3IgdGhlIHNwZWNpZmljIGxhbmd1YWdlIGdvdmVybmluZyBwZXJtaXNzaW9ucyBhbmRcbiAqIGxpbWl0YXRpb25zIHVuZGVyIHRoZSBMaWNlbnNlLlxuICovXG4vKipcbiAqIEBmaWxlb3ZlcnZpZXcgVGhpcyBzY3JpcHQgZ2VuZXJhdGVzIEJVSUxELmJhemVsIGZpbGVzIGJ5IGFuYWx5emluZ1xuICogdGhlIG5vZGVfbW9kdWxlcyBmb2xkZXIgbGF5ZWQgb3V0IGJ5IHlhcm4gb3IgbnBtLiBJdCBnZW5lcmF0ZXNcbiAqIGZpbmUgZ3JhaW5lZCBCYXplbCBgbm9kZV9tb2R1bGVfbGlicmFyeWAgdGFyZ2V0cyBmb3IgZWFjaCByb290IG5wbSBwYWNrYWdlXG4gKiBhbmQgYWxsIGZpbGVzIGZvciB0aGF0IHBhY2thZ2UgYW5kIGl0cyB0cmFuc2l0aXZlIGRlcHMgYXJlIGluY2x1ZGVkXG4gKiBpbiB0aGUgdGFyZ2V0LiBGb3IgZXhhbXBsZSwgYEA8d29ya3NwYWNlPi8vamFzbWluZWAgd291bGRcbiAqIGluY2x1ZGUgYWxsIGZpbGVzIGluIHRoZSBqYXNtaW5lIG5wbSBwYWNrYWdlIGFuZCBhbGwgb2YgaXRzXG4gKiB0cmFuc2l0aXZlIGRlcGVuZGVuY2llcy5cbiAqXG4gKiBub2RlanNfYmluYXJ5IHRhcmdldHMgYXJlIGFsc28gZ2VuZXJhdGVkIGZvciBhbGwgYGJpbmAgc2NyaXB0c1xuICogaW4gZWFjaCBwYWNrYWdlLiBGb3IgZXhhbXBsZSwgdGhlIGBAPHdvcmtzcGFjZT4vL2phc21pbmUvYmluOmphc21pbmVgXG4gKiB0YXJnZXQgd2lsbCBiZSBnZW5lcmF0ZWQgZm9yIHRoZSBgamFzbWluZWAgYmluYXJ5IGluIHRoZSBgamFzbWluZWBcbiAqIG5wbSBwYWNrYWdlLlxuICpcbiAqIEFkZGl0aW9uYWxseSwgYSBgQDx3b3Jrc3BhY2U+Ly86bm9kZV9tb2R1bGVzYCBgbm9kZV9tb2R1bGVfbGlicmFyeWBcbiAqIGlzIGdlbmVyYXRlZCB0aGF0IGluY2x1ZGVzIGFsbCBwYWNrYWdlcyB1bmRlciBub2RlX21vZHVsZXNcbiAqIGFzIHdlbGwgYXMgdGhlIC5iaW4gZm9sZGVyLlxuICpcbiAqIFRoaXMgd29yayBpcyBiYXNlZCBvZmYgdGhlIGZpbmUgZ3JhaW5lZCBkZXBzIGNvbmNlcHRzIGluXG4gKiBodHRwczovL2dpdGh1Yi5jb20vcHVicmVmL3J1bGVzX25vZGUgZGV2ZWxvcGVkIGJ5IEBwY2ouXG4gKlxuICogQHNlZSBodHRwczovL2RvY3MuZ29vZ2xlLmNvbS9kb2N1bWVudC9kLzFBZmpITUxWeUVfdll3bEhTSzdrN3lXX0lJR3BwU3hzUXRQbTlQVHIxeEVvXG4gKi9cbid1c2Ugc3RyaWN0JztcblxuXG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcyc7XG5pbXBvcnQgKiBhcyBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0ICogYXMgY3J5cHRvIGZyb20gJ2NyeXB0byc7XG5cbmZ1bmN0aW9uIGxvZ192ZXJib3NlKC4uLm06IGFueVtdKSB7XG4gIGlmICghIXByb2Nlc3MuZW52WydWRVJCT1NFX0xPR1MnXSkgY29uc29sZS5lcnJvcignW2dlbmVyYXRlX2J1aWxkX2ZpbGUuanNdJywgLi4ubSk7XG59XG5cbmNvbnN0IEJVSUxEX0ZJTEVfSEVBREVSID0gYCMgR2VuZXJhdGVkIGZpbGUgZnJvbSB5YXJuX2luc3RhbGwvbnBtX2luc3RhbGwgcnVsZS5cbiMgU2VlICQoYmF6ZWwgaW5mbyBvdXRwdXRfYmFzZSkvZXh0ZXJuYWwvYnVpbGRfYmF6ZWxfcnVsZXNfbm9kZWpzL2ludGVybmFsL25wbV9pbnN0YWxsL2dlbmVyYXRlX2J1aWxkX2ZpbGUuanNcblxuIyBBbGwgcnVsZXMgaW4gb3RoZXIgcmVwb3NpdG9yaWVzIGNhbiB1c2UgdGhlc2UgdGFyZ2V0c1xucGFja2FnZShkZWZhdWx0X3Zpc2liaWxpdHkgPSBbXCIvL3Zpc2liaWxpdHk6cHVibGljXCJdKVxuXG5gXG5cbmNvbnN0IGFyZ3MgPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoMik7XG5jb25zdCBXT1JLU1BBQ0UgPSBhcmdzWzBdO1xuY29uc3QgUlVMRV9UWVBFID0gYXJnc1sxXTtcbmNvbnN0IEVSUk9SX09OX0JBWkVMX0ZJTEVTID0gcGFyc2VJbnQoYXJnc1syXSk7XG5jb25zdCBMT0NLX0ZJTEVfUEFUSCA9IGFyZ3NbM107XG5jb25zdCBJTkNMVURFRF9GSUxFUyA9IGFyZ3NbNF0gPyBhcmdzWzRdLnNwbGl0KCcsJykgOiBbXTtcbmNvbnN0IERZTkFNSUNfREVQUyA9IEpTT04ucGFyc2UoYXJnc1s1XSB8fCAne30nKTtcblxuaWYgKHJlcXVpcmUubWFpbiA9PT0gbW9kdWxlKSB7XG4gIG1haW4oKTtcbn1cblxuLyoqXG4gKiBDcmVhdGUgYSBuZXcgZGlyZWN0b3J5IGFuZCBhbnkgbmVjZXNzYXJ5IHN1YmRpcmVjdG9yaWVzXG4gKiBpZiB0aGV5IGRvIG5vdCBleGlzdC5cbiAqL1xuZnVuY3Rpb24gbWtkaXJwKHA6IHN0cmluZykge1xuICBpZiAoIWZzLmV4aXN0c1N5bmMocCkpIHtcbiAgICBta2RpcnAocGF0aC5kaXJuYW1lKHApKTtcbiAgICBmcy5ta2RpclN5bmMocCk7XG4gIH1cbn1cblxuLyoqXG4gKiBXcml0ZXMgYSBmaWxlLCBmaXJzdCBlbnN1cmluZyB0aGF0IHRoZSBkaXJlY3RvcnkgdG9cbiAqIHdyaXRlIHRvIGV4aXN0cy5cbiAqL1xuZnVuY3Rpb24gd3JpdGVGaWxlU3luYyhwOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZykge1xuICBta2RpcnAocGF0aC5kaXJuYW1lKHApKTtcbiAgZnMud3JpdGVGaWxlU3luYyhwLCBjb250ZW50KTtcbn1cblxuLyoqXG4gKiBNYWluIGVudHJ5cG9pbnQuXG4gKi9cbmZ1bmN0aW9uIG1haW4oKSB7XG4gIC8vIGZpbmQgYWxsIHBhY2thZ2VzIChpbmNsdWRpbmcgcGFja2FnZXMgaW4gbmVzdGVkIG5vZGVfbW9kdWxlcylcbiAgY29uc3QgcGtncyA9IGZpbmRQYWNrYWdlcygpO1xuXG4gIC8vIGZsYXR0ZW4gZGVwZW5kZW5jaWVzXG4gIGZsYXR0ZW5EZXBlbmRlbmNpZXMocGtncyk7XG5cbiAgLy8gZ2VuZXJhdGUgQmF6ZWwgd29ya3NwYWNlc1xuICBnZW5lcmF0ZUJhemVsV29ya3NwYWNlcyhwa2dzKVxuXG4gIC8vIGdlbmVyYXRlIGFsbCBCVUlMRCBmaWxlc1xuICBnZW5lcmF0ZUJ1aWxkRmlsZXMocGtncylcbn1cblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gIG1haW4sXG4gIHByaW50UGFja2FnZUJpbixcbiAgYWRkRHluYW1pY0RlcGVuZGVuY2llcyxcbiAgcHJpbnRJbmRleEJ6bCxcbn07XG5cbi8qKlxuICogR2VuZXJhdGVzIGFsbCBidWlsZCBmaWxlc1xuICovXG5mdW5jdGlvbiBnZW5lcmF0ZUJ1aWxkRmlsZXMocGtnczogRGVwW10pIHtcbiAgZ2VuZXJhdGVSb290QnVpbGRGaWxlKHBrZ3MuZmlsdGVyKHBrZyA9PiAhcGtnLl9pc05lc3RlZCkpXG4gIHBrZ3MuZmlsdGVyKHBrZyA9PiAhcGtnLl9pc05lc3RlZCkuZm9yRWFjaChwa2cgPT4gZ2VuZXJhdGVQYWNrYWdlQnVpbGRGaWxlcyhwa2cpKTtcbiAgZmluZFNjb3BlcygpLmZvckVhY2goc2NvcGUgPT4gZ2VuZXJhdGVTY29wZUJ1aWxkRmlsZXMoc2NvcGUsIHBrZ3MpKTtcbn1cblxuLyoqXG4gKiBGbGF0dGVucyBkZXBlbmRlbmNpZXMgb24gYWxsIHBhY2thZ2VzXG4gKi9cbmZ1bmN0aW9uIGZsYXR0ZW5EZXBlbmRlbmNpZXMocGtnczogRGVwW10pIHtcbiAgY29uc3QgcGtnc01hcCA9IG5ldyBNYXAoKTtcbiAgcGtncy5mb3JFYWNoKHBrZyA9PiBwa2dzTWFwLnNldChwa2cuX2RpciwgcGtnKSk7XG4gIHBrZ3MuZm9yRWFjaChwa2cgPT4gZmxhdHRlblBrZ0RlcGVuZGVuY2llcyhwa2csIHBrZywgcGtnc01hcCkpO1xufVxuXG4vKipcbiAqIEhhbmRsZXMgQmF6ZWwgZmlsZXMgaW4gbnBtIGRpc3RyaWJ1dGlvbnMuXG4gKi9cbmZ1bmN0aW9uIGhpZGVCYXplbEZpbGVzKHBrZzogRGVwKSB7XG4gIGNvbnN0IGhhc0hpZGVCYXplbEZpbGVzID0gaXNEaXJlY3RvcnkoJ25vZGVfbW9kdWxlcy9AYmF6ZWwvaGlkZS1iYXplbC1maWxlcycpO1xuICBwa2cuX2ZpbGVzID0gcGtnLl9maWxlcy5tYXAoZmlsZSA9PiB7XG4gICAgY29uc3QgYmFzZW5hbWUgPSBwYXRoLmJhc2VuYW1lKGZpbGUpO1xuICAgIGNvbnN0IGJhc2VuYW1lVWMgPSBiYXNlbmFtZS50b1VwcGVyQ2FzZSgpO1xuICAgIGlmIChiYXNlbmFtZVVjID09PSAnQlVJTEQnIHx8IGJhc2VuYW1lVWMgPT09ICdCVUlMRC5CQVpFTCcpIHtcbiAgICAgIC8vIElmIGJhemVsIGZpbGVzIGFyZSBkZXRlY3RlZCBhbmQgdGhlcmUgaXMgbm8gQGJhemVsL2hpZGUtYmF6ZWwtZmlsZXMgbnBtXG4gICAgICAvLyBwYWNrYWdlIHRoZW4gZXJyb3Igb3V0IGFuZCBzdWdnZXN0IGFkZGluZyB0aGUgcGFja2FnZS4gSXQgaXMgcG9zc2libGUgdG9cbiAgICAgIC8vIGhhdmUgYmF6ZWwgQlVJTEQgZmlsZXMgd2l0aCB0aGUgcGFja2FnZSBpbnN0YWxsZWQgYXMgaXQncyBwb3N0aW5zdGFsbFxuICAgICAgLy8gc3RlcCwgd2hpY2ggaGlkZXMgYmF6ZWwgQlVJTEQgZmlsZXMsIG9ubHkgcnVucyB3aGVuIHRoZSBAYmF6ZWwvaGlkZS1iYXplbC1maWxlc1xuICAgICAgLy8gaXMgaW5zdGFsbGVkIGFuZCBub3Qgd2hlbiBuZXcgcGFja2FnZXMgYXJlIGFkZGVkICh2aWEgYHlhcm4gYWRkYFxuICAgICAgLy8gZm9yIGV4YW1wbGUpIGFmdGVyIHRoZSBpbml0aWFsIGluc3RhbGwuIEluIHRoaXMgY2FzZSwgaG93ZXZlciwgdGhlIHJlcG8gcnVsZVxuICAgICAgLy8gd2lsbCByZS1ydW4gYXMgdGhlIHBhY2thZ2UuanNvbiAmJiBsb2NrIGZpbGUgaGFzIGNoYW5nZWQgc28gd2UganVzdFxuICAgICAgLy8gaGlkZSB0aGUgYWRkZWQgQlVJTEQgZmlsZXMgZHVyaW5nIHRoZSByZXBvIHJ1bGUgcnVuIGhlcmUgc2luY2UgQGJhemVsL2hpZGUtYmF6ZWwtZmlsZXNcbiAgICAgIC8vIHdhcyBub3QgcnVuLlxuICAgICAgaWYgKCFoYXNIaWRlQmF6ZWxGaWxlcyAmJiBFUlJPUl9PTl9CQVpFTF9GSUxFUykge1xuICAgICAgICBjb25zb2xlLmVycm9yKGBucG0gcGFja2FnZSAnJHtwa2cuX2Rpcn0nIGZyb20gQCR7V09SS1NQQUNFfSAke1JVTEVfVFlQRX0gcnVsZVxuaGFzIGEgQmF6ZWwgQlVJTEQgZmlsZSAnJHtmaWxlfScuIFVzZSB0aGUgQGJhemVsL2hpZGUtYmF6ZWwtZmlsZXMgdXRpbGl0eSB0byBoaWRlIHRoZXNlIGZpbGVzLlxuU2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9iYXplbGJ1aWxkL3J1bGVzX25vZGVqcy9ibG9iL21hc3Rlci9wYWNrYWdlcy9oaWRlLWJhemVsLWZpbGVzL1JFQURNRS5tZFxuZm9yIGluc3RhbGxhdGlvbiBpbnN0cnVjdGlvbnMuYCk7XG4gICAgICAgIHByb2Nlc3MuZXhpdCgxKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIEFsbCBCYXplbCBmaWxlcyBpbiB0aGUgbnBtIGRpc3RyaWJ1dGlvbiBzaG91bGQgYmUgcmVuYW1lZCBieVxuICAgICAgICAvLyBhZGRpbmcgYSBgX2AgcHJlZml4IHNvIHRoYXQgZmlsZSB0YXJnZXRzIGRvbid0IGNyb3NzIHBhY2thZ2UgYm91bmRhcmllcy5cbiAgICAgICAgY29uc3QgbmV3RmlsZSA9IHBhdGgucG9zaXguam9pbihwYXRoLmRpcm5hbWUoZmlsZSksIGBfJHtiYXNlbmFtZX1gKTtcbiAgICAgICAgY29uc3Qgc3JjUGF0aCA9IHBhdGgucG9zaXguam9pbignbm9kZV9tb2R1bGVzJywgcGtnLl9kaXIsIGZpbGUpO1xuICAgICAgICBjb25zdCBkc3RQYXRoID0gcGF0aC5wb3NpeC5qb2luKCdub2RlX21vZHVsZXMnLCBwa2cuX2RpciwgbmV3RmlsZSk7XG4gICAgICAgIGZzLnJlbmFtZVN5bmMoc3JjUGF0aCwgZHN0UGF0aCk7XG4gICAgICAgIHJldHVybiBuZXdGaWxlO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gZmlsZTtcbiAgfSk7XG59XG5cbi8qKlxuICogR2VuZXJhdGVzIHRoZSByb290IEJVSUxEIGZpbGUuXG4gKi9cbmZ1bmN0aW9uIGdlbmVyYXRlUm9vdEJ1aWxkRmlsZShwa2dzOiBEZXBbXSkge1xuICBsZXQgZXhwb3J0c1N0YXJsYXJrID0gJyc7XG4gIHBrZ3MuZm9yRWFjaChwa2cgPT4ge3BrZy5fZmlsZXMuZm9yRWFjaChmID0+IHtcbiAgICAgICAgICAgICAgICAgZXhwb3J0c1N0YXJsYXJrICs9IGAgICAgXCJub2RlX21vZHVsZXMvJHtwa2cuX2Rpcn0vJHtmfVwiLFxuYDtcbiAgICAgICAgICAgICAgIH0pfSk7XG5cbiAgbGV0IHNyY3NTdGFybGFyayA9ICcnO1xuICBpZiAocGtncy5sZW5ndGgpIHtcbiAgICBjb25zdCBsaXN0ID0gcGtncy5tYXAocGtnID0+IGBcIi8vJHtwa2cuX2Rpcn06JHtwa2cuX25hbWV9X19maWxlc1wiLGApLmpvaW4oJ1xcbiAgICAgICAgJyk7XG4gICAgc3Jjc1N0YXJsYXJrID0gYFxuICAgICMgZGlyZWN0IHNvdXJjZXMgbGlzdGVkIGZvciBzdHJpY3QgZGVwcyBzdXBwb3J0XG4gICAgc3JjcyA9IFtcbiAgICAgICAgJHtsaXN0fVxuICAgIF0sYDtcbiAgfVxuXG4gIGxldCBkZXBzU3RhcmxhcmsgPSAnJztcbiAgaWYgKHBrZ3MubGVuZ3RoKSB7XG4gICAgY29uc3QgbGlzdCA9IHBrZ3MubWFwKHBrZyA9PiBgXCIvLyR7cGtnLl9kaXJ9OiR7cGtnLl9uYW1lfV9fY29udGVudHNcIixgKS5qb2luKCdcXG4gICAgICAgICcpO1xuICAgIGRlcHNTdGFybGFyayA9IGBcbiAgICAjIGZsYXR0ZW5lZCBsaXN0IG9mIGRpcmVjdCBhbmQgdHJhbnNpdGl2ZSBkZXBlbmRlbmNpZXMgaG9pc3RlZCB0byByb290IGJ5IHRoZSBwYWNrYWdlIG1hbmFnZXJcbiAgICBkZXBzID0gW1xuICAgICAgICAke2xpc3R9XG4gICAgXSxgO1xuICB9XG5cbiAgbGV0IGJ1aWxkRmlsZSA9IEJVSUxEX0ZJTEVfSEVBREVSICtcbiAgICAgIGBsb2FkKFwiQGJ1aWxkX2JhemVsX3J1bGVzX25vZGVqcy8vaW50ZXJuYWwvbnBtX2luc3RhbGw6bm9kZV9tb2R1bGVfbGlicmFyeS5iemxcIiwgXCJub2RlX21vZHVsZV9saWJyYXJ5XCIpXG5cbmV4cG9ydHNfZmlsZXMoW1xuJHtleHBvcnRzU3Rhcmxhcmt9XSlcblxuIyBUaGUgbm9kZV9tb2R1bGVzIGRpcmVjdG9yeSBpbiBvbmUgY2F0Y2gtYWxsIG5vZGVfbW9kdWxlX2xpYnJhcnkuXG4jIE5COiBVc2luZyB0aGlzIHRhcmdldCBtYXkgaGF2ZSBiYWQgcGVyZm9ybWFuY2UgaW1wbGljYXRpb25zIGlmXG4jIHRoZXJlIGFyZSBtYW55IGZpbGVzIGluIHRhcmdldC5cbiMgU2VlIGh0dHBzOi8vZ2l0aHViLmNvbS9iYXplbGJ1aWxkL2JhemVsL2lzc3Vlcy81MTUzLlxubm9kZV9tb2R1bGVfbGlicmFyeShcbiAgICBuYW1lID0gXCJub2RlX21vZHVsZXNcIiwke3NyY3NTdGFybGFya30ke2RlcHNTdGFybGFya31cbilcblxuYFxuXG4gIC8vIEFkZCB0aGUgbWFudWFsIGJ1aWxkIGZpbGUgY29udGVudHMgaWYgdGhleSBleGlzdHNcbiAgdHJ5IHtcbiAgICBidWlsZEZpbGUgKz0gZnMucmVhZEZpbGVTeW5jKGBtYW51YWxfYnVpbGRfZmlsZV9jb250ZW50c2AsIHtlbmNvZGluZzogJ3V0ZjgnfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgfVxuXG4gIHdyaXRlRmlsZVN5bmMoJ0JVSUxELmJhemVsJywgYnVpbGRGaWxlKTtcbn1cblxuLyoqXG4gKiBHZW5lcmF0ZXMgYWxsIEJVSUxEICYgYnpsIGZpbGVzIGZvciBhIHBhY2thZ2UuXG4gKi9cbmZ1bmN0aW9uIGdlbmVyYXRlUGFja2FnZUJ1aWxkRmlsZXMocGtnOiBEZXApIHtcbiAgbGV0IGJ1aWxkRmlsZSA9IHByaW50UGFja2FnZShwa2cpO1xuXG4gIGNvbnN0IGJpbkJ1aWxkRmlsZSA9IHByaW50UGFja2FnZUJpbihwa2cpO1xuICBpZiAoYmluQnVpbGRGaWxlLmxlbmd0aCkge1xuICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgIHBhdGgucG9zaXguam9pbihwa2cuX2RpciwgJ2JpbicsICdCVUlMRC5iYXplbCcpLCBCVUlMRF9GSUxFX0hFQURFUiArIGJpbkJ1aWxkRmlsZSk7XG4gIH1cblxuICBjb25zdCBpbmRleEZpbGUgPSBwcmludEluZGV4QnpsKHBrZyk7XG4gIGlmIChpbmRleEZpbGUubGVuZ3RoKSB7XG4gICAgd3JpdGVGaWxlU3luYyhwYXRoLnBvc2l4LmpvaW4ocGtnLl9kaXIsICdpbmRleC5iemwnKSwgaW5kZXhGaWxlKTtcbiAgICBidWlsZEZpbGUgPSBgJHtidWlsZEZpbGV9XG4jIEZvciBpbnRlZ3JhdGlvbiB0ZXN0aW5nXG5leHBvcnRzX2ZpbGVzKFtcImluZGV4LmJ6bFwiXSlcbmA7XG4gIH1cblxuICB3cml0ZUZpbGVTeW5jKHBhdGgucG9zaXguam9pbihwa2cuX2RpciwgJ0JVSUxELmJhemVsJyksIEJVSUxEX0ZJTEVfSEVBREVSICsgYnVpbGRGaWxlKTtcbn1cblxuLyoqXG4gKiBHZW5lcmF0ZSBpbnN0YWxsXzx3b3Jrc3BhY2VfbmFtZT4uYnpsIGZpbGVzIHdpdGggZnVuY3Rpb24gdG8gaW5zdGFsbCBlYWNoIHdvcmtzcGFjZS5cbiAqL1xuZnVuY3Rpb24gZ2VuZXJhdGVCYXplbFdvcmtzcGFjZXMocGtnczogRGVwW10pIHtcbiAgY29uc3Qgd29ya3NwYWNlczogQmFnPHN0cmluZz4gPSB7fTtcblxuICBmb3IgKGNvbnN0IHBrZyBvZiBwa2dzKSB7XG4gICAgaWYgKCFwa2cuYmF6ZWxXb3Jrc3BhY2VzKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IHdvcmtzcGFjZSBvZiBPYmplY3Qua2V5cyhwa2cuYmF6ZWxXb3Jrc3BhY2VzKSkge1xuICAgICAgLy8gQSBiYXplbCB3b3Jrc3BhY2UgY2FuIG9ubHkgYmUgc2V0dXAgYnkgb25lIG5wbSBwYWNrYWdlXG4gICAgICBpZiAod29ya3NwYWNlc1t3b3Jrc3BhY2VdKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXG4gICAgICAgICAgICBgQ291bGQgbm90IHNldHVwIEJhemVsIHdvcmtzcGFjZSAke3dvcmtzcGFjZX0gcmVxdWVzdGVkIGJ5IG5wbSBgICtcbiAgICAgICAgICAgIGBwYWNrYWdlICR7cGtnLl9kaXJ9QCR7cGtnLnZlcnNpb259LiBBbHJlYWR5IHNldHVwIGJ5ICR7d29ya3NwYWNlc1t3b3Jrc3BhY2VdfWApO1xuICAgICAgICBwcm9jZXNzLmV4aXQoMSk7XG4gICAgICB9XG5cbiAgICAgIGdlbmVyYXRlQmF6ZWxXb3Jrc3BhY2UocGtnLCB3b3Jrc3BhY2UpO1xuXG4gICAgICAvLyBLZWVwIHRyYWNrIG9mIHdoaWNoIG5wbSBwYWNrYWdlIHNldHVwIHRoaXMgYmF6ZWwgd29ya3NwYWNlIGZvciBsYXRlciB1c2VcbiAgICAgIHdvcmtzcGFjZXNbd29ya3NwYWNlXSA9IGAke3BrZy5fZGlyfUAke3BrZy52ZXJzaW9ufWA7XG4gICAgfVxuICB9XG5cbiAgLy8gRmluYWxseSBnZW5lcmF0ZSBpbnN0YWxsX2JhemVsX2RlcGVuZGVuY2llcy5iemxcbiAgZ2VuZXJhdGVJbnN0YWxsQmF6ZWxEZXBlbmRlbmNpZXMoT2JqZWN0LmtleXMod29ya3NwYWNlcykpO1xufVxuXG4vKipcbiAqIEdlbmVyYXRlIGluc3RhbGxfPHdvcmtzcGFjZT4uYnpsIGZpbGUgd2l0aCBmdW5jdGlvbiB0byBpbnN0YWxsIHRoZSB3b3Jrc3BhY2UuXG4gKi9cbmZ1bmN0aW9uIGdlbmVyYXRlQmF6ZWxXb3Jrc3BhY2UocGtnOiBEZXAsIHdvcmtzcGFjZTogc3RyaW5nKSB7XG4gIGxldCBiemxGaWxlID0gYCMgR2VuZXJhdGVkIGJ5IHRoZSB5YXJuX2luc3RhbGwvbnBtX2luc3RhbGwgcnVsZVxubG9hZChcIkBidWlsZF9iYXplbF9ydWxlc19ub2RlanMvL2ludGVybmFsL2NvcHlfcmVwb3NpdG9yeTpjb3B5X3JlcG9zaXRvcnkuYnpsXCIsIFwiY29weV9yZXBvc2l0b3J5XCIpXG5cbmRlZiBfbWF5YmUocmVwb19ydWxlLCBuYW1lLCAqKmt3YXJncyk6XG4gICAgaWYgbmFtZSBub3QgaW4gbmF0aXZlLmV4aXN0aW5nX3J1bGVzKCk6XG4gICAgICAgIHJlcG9fcnVsZShuYW1lID0gbmFtZSwgKiprd2FyZ3MpXG5gO1xuXG4gIGNvbnN0IHJvb3RQYXRoID0gcGtnLmJhemVsV29ya3NwYWNlc1t3b3Jrc3BhY2VdLnJvb3RQYXRoO1xuICBpZiAoIXJvb3RQYXRoKSB7XG4gICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgYE1hbGZvcm1lZCBiYXplbFdvcmtzcGFjZXMgYXR0cmlidXRlIGluICR7cGtnLl9kaXJ9QCR7cGtnLnZlcnNpb259LiBgICtcbiAgICAgICAgYE1pc3Npbmcgcm9vdFBhdGggZm9yIHdvcmtzcGFjZSAke3dvcmtzcGFjZX0uYCk7XG4gICAgcHJvY2Vzcy5leGl0KDEpO1xuICB9XG5cbiAgLy8gQ29weSBhbGwgZmlsZXMgZm9yIHRoaXMgd29ya3NwYWNlIHRvIGEgZm9sZGVyIHVuZGVyIF93b3Jrc3BhY2VzXG4gIC8vIHRvIHJlc3RvcmUgdGhlIEJhemVsIGZpbGVzIHdoaWNoIGhhdmUgYmUgcmVuYW1lZCBmcm9tIHRoZSBucG0gcGFja2FnZVxuICBjb25zdCB3b3Jrc3BhY2VTb3VyY2VQYXRoID0gcGF0aC5wb3NpeC5qb2luKCdfd29ya3NwYWNlcycsIHdvcmtzcGFjZSk7XG4gIG1rZGlycCh3b3Jrc3BhY2VTb3VyY2VQYXRoKTtcbiAgcGtnLl9maWxlcy5mb3JFYWNoKGZpbGUgPT4ge1xuICAgIGlmICgvXm5vZGVfbW9kdWxlc1svXFxcXF0vLnRlc3QoZmlsZSkpIHtcbiAgICAgIC8vIGRvbid0IGNvcHkgb3ZlciBuZXN0ZWQgbm9kZV9tb2R1bGVzXG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGxldCBkZXN0RmlsZSA9IHBhdGgucmVsYXRpdmUocm9vdFBhdGgsIGZpbGUpO1xuICAgIGlmIChkZXN0RmlsZS5zdGFydHNXaXRoKCcuLicpKSB7XG4gICAgICAvLyB0aGlzIGZpbGUgaXMgbm90IHVuZGVyIHRoZSByb290UGF0aFxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBiYXNlbmFtZSA9IHBhdGguYmFzZW5hbWUoZmlsZSk7XG4gICAgY29uc3QgYmFzZW5hbWVVYyA9IGJhc2VuYW1lLnRvVXBwZXJDYXNlKCk7XG4gICAgLy8gQmF6ZWwgQlVJTEQgZmlsZXMgZnJvbSBucG0gZGlzdHJpYnV0aW9uIHdvdWxkIGhhdmUgYmVlbiByZW5hbWVkIGVhcmxpZXIgd2l0aCBhIF8gcHJlZml4IHNvXG4gICAgLy8gd2UgcmVzdG9yZSB0aGUgbmFtZSBvbiB0aGUgY29weVxuICAgIGlmIChiYXNlbmFtZVVjID09PSAnX0JVSUxEJyB8fCBiYXNlbmFtZVVjID09PSAnX0JVSUxELkJBWkVMJykge1xuICAgICAgZGVzdEZpbGUgPSBwYXRoLnBvc2l4LmpvaW4ocGF0aC5kaXJuYW1lKGRlc3RGaWxlKSwgYmFzZW5hbWUuc3Vic3RyKDEpKTtcbiAgICB9XG4gICAgY29uc3Qgc3JjID0gcGF0aC5wb3NpeC5qb2luKCdub2RlX21vZHVsZXMnLCBwa2cuX2RpciwgZmlsZSk7XG4gICAgY29uc3QgZGVzdCA9IHBhdGgucG9zaXguam9pbih3b3Jrc3BhY2VTb3VyY2VQYXRoLCBkZXN0RmlsZSk7XG4gICAgbWtkaXJwKHBhdGguZGlybmFtZShkZXN0KSk7XG4gICAgZnMuY29weUZpbGVTeW5jKHNyYywgZGVzdCk7XG4gIH0pO1xuXG4gIC8vIFdlIGNyZWF0ZSBfYmF6ZWxfd29ya3NwYWNlX21hcmtlciB0aGF0IGlzIHVzZWQgYnkgdGhlIGN1c3RvbSBjb3B5X3JlcG9zaXRvcnlcbiAgLy8gcnVsZSB0byByZXNvbHZlIHRoZSBwYXRoIHRvIHRoZSByZXBvc2l0b3J5IHNvdXJjZSByb290LiBBIHJvb3QgQlVJTEQgZmlsZVxuICAvLyBpcyByZXF1aXJlZCB0byByZWZlcmVuY2UgX2JhemVsX3dvcmtzcGFjZV9tYXJrZXIgYXMgYSB0YXJnZXQgc28gd2UgYWxzbyBjcmVhdGVcbiAgLy8gYW4gZW1wdHkgb25lIGlmIG9uZSBkb2VzIG5vdCBleGlzdC5cbiAgaWYgKCFoYXNSb290QnVpbGRGaWxlKHBrZywgcm9vdFBhdGgpKSB7XG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgICAgcGF0aC5wb3NpeC5qb2luKHdvcmtzcGFjZVNvdXJjZVBhdGgsICdCVUlMRC5iYXplbCcpLFxuICAgICAgICAnIyBNYXJrZXIgZmlsZSB0aGF0IHRoaXMgZGlyZWN0b3J5IGlzIGEgYmF6ZWwgcGFja2FnZScpO1xuICB9XG4gIGNvbnN0IHNoYTI1NnN1bSA9IGNyeXB0by5jcmVhdGVIYXNoKCdzaGEyNTYnKTtcbiAgc2hhMjU2c3VtLnVwZGF0ZShmcy5yZWFkRmlsZVN5bmMoTE9DS19GSUxFX1BBVEgsIHtlbmNvZGluZzogJ3V0ZjgnfSkpO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgICAgcGF0aC5wb3NpeC5qb2luKHdvcmtzcGFjZVNvdXJjZVBhdGgsICdfYmF6ZWxfd29ya3NwYWNlX21hcmtlcicpLFxuICAgICAgYCMgTWFya2VyIGZpbGUgdG8gdXNlZCBieSBjdXN0b20gY29weV9yZXBvc2l0b3J5IHJ1bGVcXG4ke3NoYTI1NnN1bS5kaWdlc3QoJ2hleCcpfWApO1xuXG4gIGJ6bEZpbGUgKz0gYGRlZiBpbnN0YWxsXyR7d29ya3NwYWNlfSgpOlxuICAgIF9tYXliZShcbiAgICAgICAgY29weV9yZXBvc2l0b3J5LFxuICAgICAgICBuYW1lID0gXCIke3dvcmtzcGFjZX1cIixcbiAgICAgICAgbWFya2VyX2ZpbGUgPSBcIkAke1dPUktTUEFDRX0vL193b3Jrc3BhY2VzLyR7d29ya3NwYWNlfTpfYmF6ZWxfd29ya3NwYWNlX21hcmtlclwiLFxuICAgIClcbmA7XG5cbiAgd3JpdGVGaWxlU3luYyhgaW5zdGFsbF8ke3dvcmtzcGFjZX0uYnpsYCwgYnpsRmlsZSk7XG59XG5cbi8qKlxuICogR2VuZXJhdGUgaW5zdGFsbF9iYXplbF9kZXBlbmRlbmNpZXMuYnpsIHdpdGggZnVuY3Rpb24gdG8gaW5zdGFsbCBhbGwgd29ya3NwYWNlcy5cbiAqL1xuZnVuY3Rpb24gZ2VuZXJhdGVJbnN0YWxsQmF6ZWxEZXBlbmRlbmNpZXMod29ya3NwYWNlczogc3RyaW5nW10pIHtcbiAgbGV0IGJ6bEZpbGUgPSBgIyBHZW5lcmF0ZWQgYnkgdGhlIHlhcm5faW5zdGFsbC9ucG1faW5zdGFsbCBydWxlXG5gO1xuICB3b3Jrc3BhY2VzLmZvckVhY2god29ya3NwYWNlID0+IHtcbiAgICBiemxGaWxlICs9IGBsb2FkKFxcXCI6aW5zdGFsbF8ke3dvcmtzcGFjZX0uYnpsXFxcIiwgXFxcImluc3RhbGxfJHt3b3Jrc3BhY2V9XFxcIilcbmA7XG4gIH0pO1xuICBiemxGaWxlICs9IGBkZWYgaW5zdGFsbF9iYXplbF9kZXBlbmRlbmNpZXMoKTpcbiAgICBcIlwiXCJJbnN0YWxscyBhbGwgd29ya3NwYWNlcyBsaXN0ZWQgaW4gYmF6ZWxXb3Jrc3BhY2VzIG9mIGFsbCBucG0gcGFja2FnZXNcIlwiXCJcbmA7XG4gIHdvcmtzcGFjZXMuZm9yRWFjaCh3b3Jrc3BhY2UgPT4ge1xuICAgIGJ6bEZpbGUgKz0gYCAgICBpbnN0YWxsXyR7d29ya3NwYWNlfSgpXG5gO1xuICB9KTtcblxuICB3cml0ZUZpbGVTeW5jKCdpbnN0YWxsX2JhemVsX2RlcGVuZGVuY2llcy5iemwnLCBiemxGaWxlKTtcbn1cblxuLyoqXG4gKiBHZW5lcmF0ZSBidWlsZCBmaWxlcyBmb3IgYSBzY29wZS5cbiAqL1xuZnVuY3Rpb24gZ2VuZXJhdGVTY29wZUJ1aWxkRmlsZXMoc2NvcGU6IHN0cmluZywgcGtnczogRGVwW10pIHtcbiAgY29uc3QgYnVpbGRGaWxlID0gQlVJTERfRklMRV9IRUFERVIgKyBwcmludFNjb3BlKHNjb3BlLCBwa2dzKTtcbiAgd3JpdGVGaWxlU3luYyhwYXRoLnBvc2l4LmpvaW4oc2NvcGUsICdCVUlMRC5iYXplbCcpLCBidWlsZEZpbGUpO1xufVxuXG4vKipcbiAqIENoZWNrcyBpZiBhIHBhdGggaXMgYSBmaWxlLlxuICovXG5mdW5jdGlvbiBpc0ZpbGUocDogc3RyaW5nKSB7XG4gIHJldHVybiBmcy5leGlzdHNTeW5jKHApICYmIGZzLnN0YXRTeW5jKHApLmlzRmlsZSgpO1xufVxuXG4vKipcbiAqIENoZWNrcyBpZiBhIHBhdGggaXMgYW4gbnBtIHBhY2thZ2Ugd2hpY2ggaXMgaXMgYSBkaXJlY3Rvcnkgd2l0aCBhIHBhY2thZ2UuanNvbiBmaWxlLlxuICovXG5mdW5jdGlvbiBpc0RpcmVjdG9yeShwOiBzdHJpbmcpIHtcbiAgcmV0dXJuIGZzLmV4aXN0c1N5bmMocCkgJiYgZnMuc3RhdFN5bmMocCkuaXNEaXJlY3RvcnkoKTtcbn1cblxuLyoqXG4gKiBSZXR1cm5zIGFuIGFycmF5IG9mIGFsbCB0aGUgZmlsZXMgdW5kZXIgYSBkaXJlY3RvcnkgYXMgcmVsYXRpdmVcbiAqIHBhdGhzIHRvIHRoZSBkaXJlY3RvcnkuXG4gKi9cbmZ1bmN0aW9uIGxpc3RGaWxlcyhyb290RGlyOiBzdHJpbmcsIHN1YkRpcjogc3RyaW5nID0gJycpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGRpciA9IHBhdGgucG9zaXguam9pbihyb290RGlyLCBzdWJEaXIpO1xuICBpZiAoIWlzRGlyZWN0b3J5KGRpcikpIHtcbiAgICByZXR1cm4gW107XG4gIH1cbiAgcmV0dXJuIGZzLnJlYWRkaXJTeW5jKGRpcilcbiAgICAgIC5yZWR1Y2UoXG4gICAgICAgICAgKGZpbGVzOiBzdHJpbmdbXSwgZmlsZSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgZnVsbFBhdGggPSBwYXRoLnBvc2l4LmpvaW4oZGlyLCBmaWxlKTtcbiAgICAgICAgICAgIGNvbnN0IHJlbFBhdGggPSBwYXRoLnBvc2l4LmpvaW4oc3ViRGlyLCBmaWxlKTtcbiAgICAgICAgICAgIGNvbnN0IGlzU3ltYm9saWNMaW5rID0gZnMubHN0YXRTeW5jKGZ1bGxQYXRoKS5pc1N5bWJvbGljTGluaygpO1xuICAgICAgICAgICAgbGV0IHN0YXQ7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBzdGF0ID0gZnMuc3RhdFN5bmMoZnVsbFBhdGgpO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICBpZiAoaXNTeW1ib2xpY0xpbmspIHtcbiAgICAgICAgICAgICAgICAvLyBGaWx0ZXIgb3V0IGJyb2tlbiBzeW1ib2xpYyBsaW5rcy4gVGhlc2UgY2F1c2UgZnMuc3RhdFN5bmMoZnVsbFBhdGgpXG4gICAgICAgICAgICAgICAgLy8gdG8gZmFpbCB3aXRoIGBFTk9FTlQ6IG5vIHN1Y2ggZmlsZSBvciBkaXJlY3RvcnkgLi4uYFxuICAgICAgICAgICAgICAgIHJldHVybiBmaWxlcztcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB0aHJvdyBlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgaXNEaXJlY3RvcnkgPSBzdGF0LmlzRGlyZWN0b3J5KCk7XG4gICAgICAgICAgICBpZiAoaXNEaXJlY3RvcnkgJiYgaXNTeW1ib2xpY0xpbmspIHtcbiAgICAgICAgICAgICAgLy8gRmlsdGVyIG91dCBzeW1ib2xpYyBsaW5rcyB0byBkaXJlY3Rvcmllcy4gQW4gaXNzdWUgaW4geWFybiB2ZXJzaW9uc1xuICAgICAgICAgICAgICAvLyBvbGRlciB0aGFuIDEuMTIuMSBjcmVhdGVzIHN5bWJvbGljIGxpbmtzIHRvIGZvbGRlcnMgaW4gdGhlIC5iaW4gZm9sZGVyXG4gICAgICAgICAgICAgIC8vIHdoaWNoIGxlYWRzIHRvIEJhemVsIHRhcmdldHMgdGhhdCBjcm9zcyBwYWNrYWdlIGJvdW5kYXJpZXMuXG4gICAgICAgICAgICAgIC8vIFNlZSBodHRwczovL2dpdGh1Yi5jb20vYmF6ZWxidWlsZC9ydWxlc19ub2RlanMvaXNzdWVzLzQyOCBhbmRcbiAgICAgICAgICAgICAgLy8gaHR0cHM6Ly9naXRodWIuY29tL2JhemVsYnVpbGQvcnVsZXNfbm9kZWpzL2lzc3Vlcy80MzguXG4gICAgICAgICAgICAgIC8vIFRoaXMgaXMgdGVzdGVkIGluIC9lMmUvZmluZV9ncmFpbmVkX3N5bWxpbmtzLlxuICAgICAgICAgICAgICByZXR1cm4gZmlsZXM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gaXNEaXJlY3RvcnkgPyBmaWxlcy5jb25jYXQobGlzdEZpbGVzKHJvb3REaXIsIHJlbFBhdGgpKSA6IGZpbGVzLmNvbmNhdChyZWxQYXRoKTtcbiAgICAgICAgICB9LFxuICAgICAgICAgIFtdKVxuICAgICAgLy8gRmlsZXMgd2l0aCBzcGFjZXMgKFxceDIwKSBvciB1bmljb2RlIGNoYXJhY3RlcnMgKDxcXHgyMCAmJiA+XFx4N0UpIGFyZSBub3QgYWxsb3dlZCBpblxuICAgICAgLy8gQmF6ZWwgcnVuZmlsZXMuIFNlZSBodHRwczovL2dpdGh1Yi5jb20vYmF6ZWxidWlsZC9iYXplbC9pc3N1ZXMvNDMyN1xuICAgICAgLmZpbHRlcihmID0+ICEvW15cXHgyMS1cXHg3RV0vLnRlc3QoZikpXG4gICAgICAvLyBXZSByZXR1cm4gYSBzb3J0ZWQgYXJyYXkgc28gdGhhdCB0aGUgb3JkZXIgb2YgZmlsZXNcbiAgICAgIC8vIGlzIHRoZSBzYW1lIHJlZ2FyZGxlc3Mgb2YgcGxhdGZvcm1cbiAgICAgIC5zb3J0KCk7XG59XG5cbi8qKlxuICogUmV0dXJucyB0cnVlIGlmIHRoZSBucG0gcGFja2FnZSBkaXN0cmlidXRpb24gY29udGFpbmVkIGFcbiAqIHJvb3QgL0JVSUxEIG9yIC9CVUlMRC5iYXplbCBmaWxlLlxuICovXG5mdW5jdGlvbiBoYXNSb290QnVpbGRGaWxlKHBrZzogRGVwLCByb290UGF0aDogc3RyaW5nKSB7XG4gIGZvciAoY29uc3QgZmlsZSBvZiBwa2cuX2ZpbGVzKSB7XG4gICAgLy8gQmF6ZWwgZmlsZXMgd291bGQgaGF2ZSBiZWVuIHJlbmFtZWQgZWFybGllciB3aXRoIGEgYF9gIHByZWZpeFxuICAgIGNvbnN0IGZpbGVVYyA9IHBhdGgucmVsYXRpdmUocm9vdFBhdGgsIGZpbGUpLnRvVXBwZXJDYXNlKCk7XG4gICAgaWYgKGZpbGVVYyA9PT0gJ19CVUlMRCcgfHwgZmlsZVVjID09PSAnX0JVSUxELkJBWkVMJykge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuXG5mdW5jdGlvbiBhZGREeW5hbWljRGVwZW5kZW5jaWVzKHBrZ3M6IERlcFtdLCBkeW5hbWljX2RlcHMgPSBEWU5BTUlDX0RFUFMpIHtcbiAgZnVuY3Rpb24gbWF0Y2gobmFtZTogc3RyaW5nLCBwOiBEZXApIHtcbiAgICAvLyBBdXRvbWF0aWNhbGx5IGluY2x1ZGUgZHluYW1pYyBkZXBlbmRlbmN5IG9uIHBsdWdpbnMgb2YgdGhlIGZvcm0gcGtnLXBsdWdpbi1mb29cbiAgICBpZiAobmFtZS5zdGFydHNXaXRoKGAke3AuX21vZHVsZU5hbWV9LXBsdWdpbi1gKSkgcmV0dXJuIHRydWU7XG5cbiAgICBjb25zdCB2YWx1ZSA9IGR5bmFtaWNfZGVwc1twLl9tb2R1bGVOYW1lXTtcbiAgICBpZiAobmFtZSA9PT0gdmFsdWUpIHJldHVybiB0cnVlO1xuXG4gICAgLy8gU3VwcG9ydCB3aWxkY2FyZCBtYXRjaFxuICAgIGlmICh2YWx1ZSAmJiB2YWx1ZS5pbmNsdWRlcygnKicpICYmIG5hbWUuc3RhcnRzV2l0aCh2YWx1ZS5zdWJzdHJpbmcoMCwgdmFsdWUuaW5kZXhPZignKicpKSkpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBwa2dzLmZvckVhY2gocCA9PiB7XG4gICAgcC5fZHluYW1pY0RlcGVuZGVuY2llcyA9XG4gICAgICAgIHBrZ3MuZmlsdGVyKFxuICAgICAgICAgICAgICAgIC8vIEZpbHRlciBlbnRyaWVzIGxpa2VcbiAgICAgICAgICAgICAgICAvLyBcIl9kaXJcIjpcImNoZWNrLXNpZGUtZWZmZWN0cy9ub2RlX21vZHVsZXMvcm9sbHVwLXBsdWdpbi1ub2RlLXJlc29sdmVcIlxuICAgICAgICAgICAgICAgIHggPT4gIXguX2Rpci5pbmNsdWRlcygnL25vZGVfbW9kdWxlcy8nKSAmJiAhIXguX21vZHVsZU5hbWUgJiZcbiAgICAgICAgICAgICAgICAgICAgbWF0Y2goeC5fbW9kdWxlTmFtZSwgcCkpXG4gICAgICAgICAgICAubWFwKGR5biA9PiBgLy8ke2R5bi5fZGlyfToke2R5bi5fbmFtZX1gKTtcbiAgfSk7XG59XG5cbi8qKlxuICogRmluZHMgYW5kIHJldHVybnMgYW4gYXJyYXkgb2YgYWxsIHBhY2thZ2VzIHVuZGVyIGEgZ2l2ZW4gcGF0aC5cbiAqL1xuZnVuY3Rpb24gZmluZFBhY2thZ2VzKHAgPSAnbm9kZV9tb2R1bGVzJykge1xuICBpZiAoIWlzRGlyZWN0b3J5KHApKSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG5cbiAgY29uc3QgcGtnczogRGVwW10gPSBbXTtcblxuICBjb25zdCBsaXN0aW5nID0gZnMucmVhZGRpclN5bmMocCk7XG5cbiAgY29uc3QgcGFja2FnZXMgPSBsaXN0aW5nXG4gICAgICAgICAgICAgICAgICAgICAgIC8vIGZpbHRlciBvdXQgc2NvcGVzXG4gICAgICAgICAgICAgICAgICAgICAgIC5maWx0ZXIoZiA9PiAhZi5zdGFydHNXaXRoKCdAJykpXG4gICAgICAgICAgICAgICAgICAgICAgIC8vIGZpbHRlciBvdXQgZm9sZGVycyBzdWNoIGFzIGAuYmluYCB3aGljaCBjYW4gY3JlYXRlXG4gICAgICAgICAgICAgICAgICAgICAgIC8vIGlzc3VlcyBvbiBXaW5kb3dzIHNpbmNlIHRoZXNlIGFyZSBcImhpZGRlblwiIGJ5IGRlZmF1bHRcbiAgICAgICAgICAgICAgICAgICAgICAgLmZpbHRlcihmID0+ICFmLnN0YXJ0c1dpdGgoJy4nKSlcbiAgICAgICAgICAgICAgICAgICAgICAgLm1hcChmID0+IHBhdGgucG9zaXguam9pbihwLCBmKSlcbiAgICAgICAgICAgICAgICAgICAgICAgLmZpbHRlcihmID0+IGlzRGlyZWN0b3J5KGYpKTtcblxuICBwYWNrYWdlcy5mb3JFYWNoKFxuICAgICAgZiA9PiBwa2dzLnB1c2gocGFyc2VQYWNrYWdlKGYpLCAuLi5maW5kUGFja2FnZXMocGF0aC5wb3NpeC5qb2luKGYsICdub2RlX21vZHVsZXMnKSkpKTtcblxuICBjb25zdCBzY29wZXMgPSBsaXN0aW5nLmZpbHRlcihmID0+IGYuc3RhcnRzV2l0aCgnQCcpKVxuICAgICAgICAgICAgICAgICAgICAgLm1hcChmID0+IHBhdGgucG9zaXguam9pbihwLCBmKSlcbiAgICAgICAgICAgICAgICAgICAgIC5maWx0ZXIoZiA9PiBpc0RpcmVjdG9yeShmKSk7XG4gIHNjb3Blcy5mb3JFYWNoKGYgPT4gcGtncy5wdXNoKC4uLmZpbmRQYWNrYWdlcyhmKSkpO1xuXG4gIGFkZER5bmFtaWNEZXBlbmRlbmNpZXMocGtncyk7XG5cbiAgcmV0dXJuIHBrZ3M7XG59XG5cbi8qKlxuICogRmluZHMgYW5kIHJldHVybnMgYW4gYXJyYXkgb2YgYWxsIHBhY2thZ2Ugc2NvcGVzIGluIG5vZGVfbW9kdWxlcy5cbiAqL1xuZnVuY3Rpb24gZmluZFNjb3BlcygpIHtcbiAgY29uc3QgcCA9ICdub2RlX21vZHVsZXMnO1xuICBpZiAoIWlzRGlyZWN0b3J5KHApKSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG5cbiAgY29uc3QgbGlzdGluZyA9IGZzLnJlYWRkaXJTeW5jKHApO1xuXG4gIGNvbnN0IHNjb3BlcyA9IGxpc3RpbmcuZmlsdGVyKGYgPT4gZi5zdGFydHNXaXRoKCdAJykpXG4gICAgICAgICAgICAgICAgICAgICAubWFwKGYgPT4gcGF0aC5wb3NpeC5qb2luKHAsIGYpKVxuICAgICAgICAgICAgICAgICAgICAgLmZpbHRlcihmID0+IGlzRGlyZWN0b3J5KGYpKVxuICAgICAgICAgICAgICAgICAgICAgLm1hcChmID0+IGYucmVwbGFjZSgvXm5vZGVfbW9kdWxlc1xcLy8sICcnKSk7XG5cbiAgcmV0dXJuIHNjb3Blcztcbn1cblxuLyoqXG4gKiBHaXZlbiB0aGUgbmFtZSBvZiBhIHRvcC1sZXZlbCBmb2xkZXIgaW4gbm9kZV9tb2R1bGVzLCBwYXJzZSB0aGVcbiAqIHBhY2thZ2UganNvbiBhbmQgcmV0dXJuIGl0IGFzIGFuIG9iamVjdCBhbG9uZyB3aXRoXG4gKiBzb21lIGFkZGl0aW9uYWwgaW50ZXJuYWwgYXR0cmlidXRlcyBwcmVmaXhlZCB3aXRoICdfJy5cbiAqL1xuZnVuY3Rpb24gcGFyc2VQYWNrYWdlKHA6IHN0cmluZyk6IERlcCB7XG4gIC8vIFBhcnNlIHRoZSBwYWNrYWdlLmpzb24gZmlsZSBvZiB0aGlzIHBhY2thZ2VcbiAgY29uc3QgcGFja2FnZUpzb24gPSBwYXRoLnBvc2l4LmpvaW4ocCwgJ3BhY2thZ2UuanNvbicpO1xuICBjb25zdCBwa2cgPSBpc0ZpbGUocGFja2FnZUpzb24pID8gSlNPTi5wYXJzZShmcy5yZWFkRmlsZVN5bmMocGFja2FnZUpzb24sIHtlbmNvZGluZzogJ3V0ZjgnfSkpIDpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHt2ZXJzaW9uOiAnMC4wLjAnfTtcblxuICAvLyBUcmltIHRoZSBsZWFkaW5nIG5vZGVfbW9kdWxlcyBmcm9tIHRoZSBwYXRoIGFuZFxuICAvLyBhc3NpZ24gdG8gX2RpciBmb3IgZnV0dXJlIHVzZVxuICBwa2cuX2RpciA9IHAucmVwbGFjZSgvXm5vZGVfbW9kdWxlc1xcLy8sICcnKTtcblxuICAvLyBTdGFzaCB0aGUgcGFja2FnZSBkaXJlY3RvcnkgbmFtZSBmb3IgZnV0dXJlIHVzZVxuICBwa2cuX25hbWUgPSBwa2cuX2Rpci5zcGxpdCgnLycpLnBvcCgpO1xuXG4gIC8vIE1vZHVsZSBuYW1lIG9mIHRoZSBwYWNrYWdlLiBVbmxpa2UgXCJfbmFtZVwiIHRoaXMgcmVwcmVzZW50cyB0aGVcbiAgLy8gZnVsbCBwYWNrYWdlIG5hbWUgKGluY2x1ZGluZyBzY29wZSBuYW1lKS5cbiAgcGtnLl9tb2R1bGVOYW1lID0gcGtnLm5hbWUgfHwgYCR7cGtnLl9kaXJ9LyR7cGtnLl9uYW1lfWA7XG5cbiAgLy8gS2VlcCB0cmFjayBvZiB3aGV0aGVyIG9yIG5vdCB0aGlzIGlzIGEgbmVzdGVkIHBhY2thZ2VcbiAgcGtnLl9pc05lc3RlZCA9IC9cXC9ub2RlX21vZHVsZXNcXC8vLnRlc3QocCk7XG5cbiAgLy8gTGlzdCBhbGwgdGhlIGZpbGVzIGluIHRoZSBucG0gcGFja2FnZSBmb3IgbGF0ZXIgdXNlXG4gIHBrZy5fZmlsZXMgPSBsaXN0RmlsZXMocCk7XG5cbiAgLy8gSW5pdGlhbGl6ZSBfZGVwZW5kZW5jaWVzIHRvIGFuIGVtcHR5IGFycmF5XG4gIC8vIHdoaWNoIGlzIGxhdGVyIGZpbGxlZCB3aXRoIHRoZSBmbGF0dGVuZWQgZGVwZW5kZW5jeSBsaXN0XG4gIHBrZy5fZGVwZW5kZW5jaWVzID0gW107XG5cbiAgLy8gSGlkZSBiYXplbCBmaWxlcyBpbiB0aGlzIHBhY2thZ2UuIFdlIGRvIHRoaXMgYmVmb3JlIHBhcnNpbmdcbiAgLy8gdGhlIG5leHQgcGFja2FnZSB0byBwcmV2ZW50IGlzc3VlcyBjYXVzZWQgYnkgc3ltbGlua3MgYmV0d2VlblxuICAvLyBwYWNrYWdlIGFuZCBuZXN0ZWQgcGFja2FnZXMgc2V0dXAgYnkgdGhlIHBhY2thZ2UgbWFuYWdlci5cbiAgaGlkZUJhemVsRmlsZXMocGtnKTtcblxuICByZXR1cm4gcGtnO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIGEgYmluIGVudHJ5IGlzIGEgbm9uLWVtcHR5IHBhdGhcbiAqL1xuZnVuY3Rpb24gaXNWYWxpZEJpblBhdGgoZW50cnk6IGFueSkge1xuICByZXR1cm4gaXNWYWxpZEJpblBhdGhTdHJpbmdWYWx1ZShlbnRyeSkgfHwgaXNWYWxpZEJpblBhdGhPYmplY3RWYWx1ZXMoZW50cnkpO1xufVxuXG4vKipcbiAqIElmIGdpdmVuIGEgc3RyaW5nLCBjaGVjayBpZiBhIGJpbiBlbnRyeSBpcyBhIG5vbi1lbXB0eSBwYXRoXG4gKi9cbmZ1bmN0aW9uIGlzVmFsaWRCaW5QYXRoU3RyaW5nVmFsdWUoZW50cnk6IGFueSkge1xuICByZXR1cm4gdHlwZW9mIGVudHJ5ID09PSAnc3RyaW5nJyAmJiBlbnRyeSAhPT0gJyc7XG59XG5cbi8qKlxuICogSWYgZ2l2ZW4gYW4gb2JqZWN0IGxpdGVyYWwsIGNoZWNrIGlmIGEgYmluIGVudHJ5IG9iamVjdHMgaGFzIGF0IGxlYXN0IG9uZSBhIG5vbi1lbXB0eSBwYXRoXG4gKiBFeGFtcGxlIDE6IHsgZW50cnk6ICcuL3BhdGgvdG8vc2NyaXB0LmpzJyB9ID09PiBWQUxJRFxuICogRXhhbXBsZSAyOiB7IGVudHJ5OiAnJyB9ID09PiBJTlZBTElEXG4gKiBFeGFtcGxlIDM6IHsgZW50cnk6ICcuL3BhdGgvdG8vc2NyaXB0LmpzJywgZW1wdHk6ICcnIH0gPT0+IFZBTElEXG4gKi9cbmZ1bmN0aW9uIGlzVmFsaWRCaW5QYXRoT2JqZWN0VmFsdWVzKGVudHJ5OiBCYWc8c3RyaW5nPik6IGJvb2xlYW4ge1xuICAvLyBXZSBhbGxvdyBhdCBsZWFzdCBvbmUgdmFsaWQgZW50cnkgcGF0aCAoaWYgYW55KS5cbiAgcmV0dXJuIGVudHJ5ICYmIHR5cGVvZiBlbnRyeSA9PT0gJ29iamVjdCcgJiZcbiAgICAgIE9iamVjdFsndmFsdWVzJ10oZW50cnkpLmZpbHRlcihfZW50cnkgPT4gaXNWYWxpZEJpblBhdGgoX2VudHJ5KSkubGVuZ3RoID4gMDtcbn1cblxuLyoqXG4gKiBDbGVhbnVwIGEgcGFja2FnZS5qc29uIFwiYmluXCIgcGF0aC5cbiAqXG4gKiBCaW4gcGF0aHMgdXN1YWxseSBjb21lIGluIDIgZmxhdm9yczogJy4vYmluL2Zvbycgb3IgJ2Jpbi9mb28nLFxuICogc29tZXRpbWVzIG90aGVyIHN0dWZmIGxpa2UgJ2xpYi9mb28nLiAgUmVtb3ZlIHByZWZpeCAnLi8nIGlmIGl0XG4gKiBleGlzdHMuXG4gKi9cbmZ1bmN0aW9uIGNsZWFudXBCaW5QYXRoKHA6IHN0cmluZykge1xuICBwID0gcC5yZXBsYWNlKC9cXFxcL2csICcvJyk7XG4gIGlmIChwLmluZGV4T2YoJy4vJykgPT09IDApIHtcbiAgICBwID0gcC5zbGljZSgyKTtcbiAgfVxuICByZXR1cm4gcDtcbn1cblxuLyoqXG4gKiBDbGVhbnVwIGEgcGFja2FnZS5qc29uIGVudHJ5IHBvaW50IHN1Y2ggYXMgXCJtYWluXCJcbiAqXG4gKiBSZW1vdmVzICcuLycgaWYgaXQgZXhpc3RzLlxuICogQXBwZW5kcyBgaW5kZXguanNgIGlmIHAgZW5kcyB3aXRoIGAvYC5cbiAqL1xuZnVuY3Rpb24gY2xlYW51cEVudHJ5UG9pbnRQYXRoKHA6IHN0cmluZykge1xuICBwID0gcC5yZXBsYWNlKC9cXFxcL2csICcvJyk7XG4gIGlmIChwLmluZGV4T2YoJy4vJykgPT09IDApIHtcbiAgICBwID0gcC5zbGljZSgyKTtcbiAgfVxuICBpZiAocC5lbmRzV2l0aCgnLycpKSB7XG4gICAgcCArPSAnaW5kZXguanMnO1xuICB9XG4gIHJldHVybiBwO1xufVxuXG4vKipcbiAqIENsZWFucyB1cCB0aGUgZ2l2ZW4gcGF0aFxuICogVGhlbiB0cmllcyB0byByZXNvbHZlIHRoZSBwYXRoIGludG8gYSBmaWxlIGFuZCB3YXJucyBpZiBWRVJCT1NFX0xPR1Mgc2V0IGFuZCB0aGUgZmlsZSBkb3Nlbid0XG4gKiBleGlzdFxuICogQHBhcmFtIHthbnl9IHBrZ1xuICogQHBhcmFtIHtzdHJpbmd9IHBhdGhcbiAqIEByZXR1cm5zIHtzdHJpbmcgfCB1bmRlZmluZWR9XG4gKi9cbmZ1bmN0aW9uIGZpbmRFbnRyeUZpbGUocGtnOiBEZXAsIHBhdGg6IHN0cmluZykge1xuICBjb25zdCBjbGVhblBhdGggPSBjbGVhbnVwRW50cnlQb2ludFBhdGgocGF0aCk7XG4gIC8vIGNoZWNrIGlmIG1haW4gZW50cnkgcG9pbnQgZXhpc3RzXG4gIGNvbnN0IGVudHJ5RmlsZSA9IGZpbmRGaWxlKHBrZywgY2xlYW5QYXRoKSB8fCBmaW5kRmlsZShwa2csIGAke2NsZWFuUGF0aH0uanNgKTtcbiAgaWYgKCFlbnRyeUZpbGUpIHtcbiAgICAvLyBJZiBlbnRyeVBvaW50IGVudHJ5IHBvaW50IGxpc3RlZCBjb3VsZCBub3QgYmUgcmVzb2x2ZWQgdG8gYSBmaWxlXG4gICAgLy8gVGhpcyBjYW4gaGFwcGVuXG4gICAgLy8gaW4gc29tZSBucG0gcGFja2FnZXMgdGhhdCBsaXN0IGFuIGluY29ycmVjdCBtYWluIHN1Y2ggYXMgdjgtY292ZXJhZ2VAMS4wLjhcbiAgICAvLyB3aGljaCBsaXN0cyBgXCJtYWluXCI6IFwiaW5kZXguanNcImAgYnV0IHRoYXQgZmlsZSBkb2VzIG5vdCBleGlzdC5cbiAgICBsb2dfdmVyYm9zZShcbiAgICAgICAgYGNvdWxkIG5vdCBmaW5kIGVudHJ5IHBvaW50IGZvciB0aGUgcGF0aCAke2NsZWFuUGF0aH0gZ2l2ZW4gYnkgbnBtIHBhY2thZ2UgJHtwa2cuX25hbWV9YCk7XG4gIH1cbiAgcmV0dXJuIGVudHJ5RmlsZTtcbn1cblxuLyoqXG4gKiBUcmllcyB0byByZXNvbHZlIHRoZSBlbnRyeVBvaW50IGZpbGUgZnJvbSB0aGUgcGtnIGZvciBhIGdpdmVuIG1haW5GaWxlTmFtZVxuICpcbiAqIEBwYXJhbSB7YW55fSBwa2dcbiAqIEBwYXJhbSB7J2Jyb3dzZXInIHwgJ21vZHVsZScgfCAnbWFpbid9IG1haW5GaWxlTmFtZVxuICogQHJldHVybnMge3N0cmluZyB8IHVuZGVmaW5lZH0gdGhlIHBhdGggb3IgdW5kZWZpbmVkIGlmIHdlIGNhbnQgcmVzb2x2ZSB0aGUgZmlsZVxuICovXG5mdW5jdGlvbiByZXNvbHZlTWFpbkZpbGUocGtnOiBEZXAsIG1haW5GaWxlTmFtZTogc3RyaW5nKSB7XG4gIGNvbnN0IG1haW5FbnRyeUZpZWxkID0gcGtnW21haW5GaWxlTmFtZV07XG5cbiAgaWYgKG1haW5FbnRyeUZpZWxkKSB7XG4gICAgaWYgKHR5cGVvZiBtYWluRW50cnlGaWVsZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHJldHVybiBmaW5kRW50cnlGaWxlKHBrZywgbWFpbkVudHJ5RmllbGQpXG5cbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBtYWluRW50cnlGaWVsZCA9PT0gJ29iamVjdCcgJiYgbWFpbkZpbGVOYW1lID09PSAnYnJvd3NlcicpIHtcbiAgICAgIC8vIGJyb3dzZXIgaGFzIGEgd2VpcmQgd2F5IG9mIGRlZmluaW5nIHRoaXNcbiAgICAgIC8vIHRoZSBicm93c2VyIHZhbHVlIGlzIGFuIG9iamVjdCBsaXN0aW5nIGZpbGVzIHRvIGFsaWFzLCB1c3VhbGx5IHBvaW50aW5nIHRvIGEgYnJvd3NlciBkaXJcbiAgICAgIGNvbnN0IGluZGV4RW50cnlQb2ludCA9IG1haW5FbnRyeUZpZWxkWydpbmRleC5qcyddIHx8IG1haW5FbnRyeUZpZWxkWycuL2luZGV4LmpzJ107XG4gICAgICBpZiAoaW5kZXhFbnRyeVBvaW50KSB7XG4gICAgICAgIHJldHVybiBmaW5kRW50cnlGaWxlKHBrZywgaW5kZXhFbnRyeVBvaW50KVxuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG4vKipcbiAqIFRyaWVzIHRvIHJlc29sdmUgdGhlIG1haW5GaWxlIGZyb20gYSBnaXZlbiBwa2dcbiAqIFRoaXMgdXNlcyBzZXZlYWwgbWFpbkZpbGVOYW1lcyBpbiBwcmlvcml0eSB0byBmaW5kIGEgY29ycmVjdCB1c2FibGUgZmlsZVxuICogQHBhcmFtIHthbnl9IHBrZ1xuICogQHJldHVybnMge3N0cmluZyB8IHVuZGVmaW5lZH1cbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZVBrZ01haW5GaWxlKHBrZzogRGVwKSB7XG4gIC8vIGVzMjAxNSBpcyBhbm90aGVyIG9wdGlvbiBmb3IgbWFpbkZpbGUgaGVyZVxuICAvLyBidXQgaXRzIHZlcnkgdW5jb21tb24gYW5kIGltIG5vdCBzdXJlIHdoYXQgcHJpb3JpdHkgaXQgdGFrZXNcbiAgLy9cbiAgLy8gdGhpcyBsaXN0IGlzIG9yZGVyZWQsIHdlIHRyeSByZXNvbHZlIGBicm93c2VyYCBmaXJzdCwgdGhlbiBgbW9kdWxlYCBhbmQgZmluYWxseSBmYWxsIGJhY2sgdG9cbiAgLy8gYG1haW5gXG4gIGNvbnN0IG1haW5GaWxlTmFtZXMgPSBbJ2Jyb3dzZXInLCAnbW9kdWxlJywgJ21haW4nXVxuXG4gICAgICBmb3IgKGNvbnN0IG1haW5GaWxlIG9mIG1haW5GaWxlTmFtZXMpIHtcbiAgICBjb25zdCByZXNvbHZlZE1haW5GaWxlID0gcmVzb2x2ZU1haW5GaWxlKHBrZywgbWFpbkZpbGUpO1xuICAgIGlmIChyZXNvbHZlZE1haW5GaWxlKSB7XG4gICAgICByZXR1cm4gcmVzb2x2ZWRNYWluRmlsZTtcbiAgICB9XG4gIH1cblxuICAvLyBpZiB3ZSBjYW50IGZpbmQgYW55IGNvcnJlY3QgZmlsZSByZWZlcmVuY2VzIGZyb20gdGhlIHBrZ1xuICAvLyB0aGVuIHdlIGp1c3QgdHJ5IGxvb2tpbmcgYXJvdW5kIGZvciBjb21tb24gcGF0dGVybnNcbiAgY29uc3QgbWF5YmVSb290SW5kZXggPSBmaW5kRW50cnlGaWxlKHBrZywgJ2luZGV4LmpzJyk7XG4gIGlmIChtYXliZVJvb3RJbmRleCkge1xuICAgIHJldHVybiBtYXliZVJvb3RJbmRleFxuICB9XG5cbiAgY29uc3QgbWF5YmVTZWxmTmFtZWRJbmRleCA9IGZpbmRFbnRyeUZpbGUocGtnLCBgJHtwa2cuX25hbWV9LmpzYCk7XG4gIGlmIChtYXliZVNlbGZOYW1lZEluZGV4KSB7XG4gICAgcmV0dXJuIG1heWJlU2VsZk5hbWVkSW5kZXg7XG4gIH1cblxuICAvLyBub25lIG9mIHRoZSBtZXRob2RzIHdlIHRyaWVkIHJlc3VsdGVkIGluIGEgZmlsZVxuICBsb2dfdmVyYm9zZShgY291bGQgbm90IGZpbmQgZW50cnkgcG9pbnQgZm9yIG5wbSBwYWNrYWdlICR7cGtnLl9uYW1lfWApO1xuXG4gIC8vIGF0IHRoaXMgcG9pbnQgdGhlcmUncyBub3RoaW5nIGxlZnQgZm9yIHVzIHRvIHRyeSwgc28gcmV0dXJuIG5vdGhpbmdcbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxudHlwZSBCYWc8VD4gPVxuICAgIHtcbiAgICAgIFtrOiBzdHJpbmddOiBUXG4gICAgfVxuXG4vKipcbiAqIEZsYXR0ZW5zIGFsbCB0cmFuc2l0aXZlIGRlcGVuZGVuY2llcyBvZiBhIHBhY2thZ2VcbiAqIGludG8gYSBfZGVwZW5kZW5jaWVzIGFycmF5LlxuICovXG5mdW5jdGlvbiBmbGF0dGVuUGtnRGVwZW5kZW5jaWVzKHBrZzogRGVwLCBkZXA6IERlcCwgcGtnc01hcDogTWFwPHN0cmluZywgRGVwPikge1xuICBpZiAocGtnLl9kZXBlbmRlbmNpZXMuaW5kZXhPZihkZXApICE9PSAtMSkge1xuICAgIC8vIGNpcmN1bGFyIGRlcGVuZGVuY3lcbiAgICByZXR1cm47XG4gIH1cbiAgcGtnLl9kZXBlbmRlbmNpZXMucHVzaChkZXApO1xuICBjb25zdCBmaW5kRGVwcyA9IGZ1bmN0aW9uKHRhcmdldERlcHM6IEJhZzxzdHJpbmc+LCByZXF1aXJlZDogYm9vbGVhbiwgZGVwVHlwZTogc3RyaW5nKSB7XG4gICAgT2JqZWN0LmtleXModGFyZ2V0RGVwcyB8fCB7fSlcbiAgICAgICAgLm1hcCh0YXJnZXREZXAgPT4ge1xuICAgICAgICAgIC8vIGxvb2sgZm9yIG1hdGNoaW5nIG5lc3RlZCBwYWNrYWdlXG4gICAgICAgICAgY29uc3QgZGlyU2VnbWVudHMgPSBkZXAuX2Rpci5zcGxpdCgnLycpO1xuICAgICAgICAgIHdoaWxlIChkaXJTZWdtZW50cy5sZW5ndGgpIHtcbiAgICAgICAgICAgIGNvbnN0IG1heWJlID0gcGF0aC5wb3NpeC5qb2luKC4uLmRpclNlZ21lbnRzLCAnbm9kZV9tb2R1bGVzJywgdGFyZ2V0RGVwKTtcbiAgICAgICAgICAgIGlmIChwa2dzTWFwLmhhcyhtYXliZSkpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIHBrZ3NNYXAuZ2V0KG1heWJlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGRpclNlZ21lbnRzLnBvcCgpO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBsb29rIGZvciBtYXRjaGluZyByb290IHBhY2thZ2VcbiAgICAgICAgICBpZiAocGtnc01hcC5oYXModGFyZ2V0RGVwKSkge1xuICAgICAgICAgICAgcmV0dXJuIHBrZ3NNYXAuZ2V0KHRhcmdldERlcCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIGRlcGVuZGVuY3kgbm90IGZvdW5kXG4gICAgICAgICAgaWYgKHJlcXVpcmVkKSB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKGBjb3VsZCBub3QgZmluZCAke2RlcFR5cGV9ICcke3RhcmdldERlcH0nIG9mICcke2RlcC5fZGlyfSdgKTtcbiAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgIH0pXG4gICAgICAgIC5maWx0ZXIoZGVwID0+ICEhZGVwKVxuICAgICAgICAuZm9yRWFjaChkZXAgPT4gZmxhdHRlblBrZ0RlcGVuZGVuY2llcyhwa2csIGRlcCEsIHBrZ3NNYXApKTtcbiAgfTtcbiAgLy8gbnBtIHdpbGwgaW4gc29tZSBjYXNlcyBhZGQgb3B0aW9uYWxEZXBlbmRlbmNpZXMgdG8gdGhlIGxpc3RcbiAgLy8gb2YgZGVwZW5kZW5jaWVzIHRvIHRoZSBwYWNrYWdlLmpzb24gaXQgd3JpdGVzIHRvIG5vZGVfbW9kdWxlcy5cbiAgLy8gV2UgZGVsZXRlIHRoZXNlIGhlcmUgaWYgdGhleSBleGlzdCBhcyB0aGV5IG1heSByZXN1bHRcbiAgLy8gaW4gZXhwZWN0ZWQgZGVwZW5kZW5jaWVzIHRoYXQgYXJlIG5vdCBmb3VuZC5cbiAgaWYgKGRlcC5kZXBlbmRlbmNpZXMgJiYgZGVwLm9wdGlvbmFsRGVwZW5kZW5jaWVzKSB7XG4gICAgT2JqZWN0LmtleXMoZGVwLm9wdGlvbmFsRGVwZW5kZW5jaWVzKS5mb3JFYWNoKG9wdGlvbmFsRGVwID0+IHtcbiAgICAgIGRlbGV0ZSBkZXAuZGVwZW5kZW5jaWVzW29wdGlvbmFsRGVwXTtcbiAgICB9KTtcbiAgfVxuXG4gIGZpbmREZXBzKGRlcC5kZXBlbmRlbmNpZXMsIHRydWUsICdkZXBlbmRlbmN5Jyk7XG4gIGZpbmREZXBzKGRlcC5wZWVyRGVwZW5kZW5jaWVzLCB0cnVlLCAncGVlciBkZXBlbmRlbmN5Jyk7XG4gIC8vIGBvcHRpb25hbERlcGVuZGVuY2llc2AgdGhhdCBhcmUgbWlzc2luZyBzaG91bGQgYmUgc2lsZW50bHlcbiAgLy8gaWdub3JlZCBzaW5jZSB0aGUgbnBtL3lhcm4gd2lsbCBub3QgZmFpbCBpZiB0aGVzZSBkZXBlbmRlbmNpZXNcbiAgLy8gZmFpbCB0byBpbnN0YWxsLiBQYWNrYWdlcyBzaG91bGQgaGFuZGxlIHRoZSBjYXNlcyB3aGVyZSB0aGVzZVxuICAvLyBkZXBlbmRlbmNpZXMgYXJlIG1pc3NpbmcgZ3JhY2VmdWxseSBhdCBydW50aW1lLlxuICAvLyBBbiBleGFtcGxlIG9mIHRoaXMgaXMgdGhlIGBjaG9raWRhcmAgcGFja2FnZSB3aGljaCBzcGVjaWZpZXNcbiAgLy8gYGZzZXZlbnRzYCBhcyBhbiBvcHRpb25hbERlcGVuZGVuY3kuIE9uIE9TWCwgYGZzZXZlbnRzYFxuICAvLyBpcyBpbnN0YWxsZWQgc3VjY2Vzc2Z1bGx5LCBidXQgb24gV2luZG93cyAmIExpbnV4LCBgZnNldmVudHNgXG4gIC8vIGZhaWxzIHRvIGluc3RhbGwgYW5kIHRoZSBwYWNrYWdlIHdpbGwgbm90IGJlIHByZXNlbnQgd2hlblxuICAvLyBjaGVja2luZyB0aGUgZGVwZW5kZW5jaWVzIG9mIGBjaG9raWRhcmAuXG4gIGZpbmREZXBzKGRlcC5vcHRpb25hbERlcGVuZGVuY2llcywgZmFsc2UsICdvcHRpb25hbCBkZXBlbmRlbmN5Jyk7XG59XG5cbi8qKlxuICogUmVmb3JtYXQvcHJldHR5LXByaW50IGEganNvbiBvYmplY3QgYXMgYSBza3lsYXJrIGNvbW1lbnQgKGVhY2ggbGluZVxuICogc3RhcnRzIHdpdGggJyMgJykuXG4gKi9cbmZ1bmN0aW9uIHByaW50SnNvbihwa2c6IERlcCkge1xuICAvLyBDbG9uZSBhbmQgbW9kaWZ5IF9kZXBlbmRlbmNpZXMgdG8gYXZvaWQgY2lyY3VsYXIgaXNzdWVzIHdoZW4gSlNPTmlmeWluZ1xuICAvLyAmIGRlbGV0ZSBfZmlsZXMgYXJyYXlcbiAgY29uc3QgY2xvbmVkOiBhbnkgPSB7Li4ucGtnfTtcbiAgY2xvbmVkLl9kZXBlbmRlbmNpZXMgPSBwa2cuX2RlcGVuZGVuY2llcy5tYXAoZGVwID0+IGRlcC5fZGlyKTtcbiAgZGVsZXRlIGNsb25lZC5fZmlsZXM7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeShjbG9uZWQsIG51bGwsIDIpLnNwbGl0KCdcXG4nKS5tYXAobGluZSA9PiBgIyAke2xpbmV9YCkuam9pbignXFxuJyk7XG59XG5cbi8qKlxuICogQSBmaWx0ZXIgZnVuY3Rpb24gZm9yIGZpbGVzIGluIGFuIG5wbSBwYWNrYWdlLiBDb21wYXJpc29uIGlzIGNhc2UtaW5zZW5zaXRpdmUuXG4gKiBAcGFyYW0gZmlsZXMgYXJyYXkgb2YgZmlsZXMgdG8gZmlsdGVyXG4gKiBAcGFyYW0gZXh0cyBsaXN0IG9mIHdoaXRlIGxpc3RlZCBjYXNlLWluc2Vuc2l0aXZlIGV4dGVuc2lvbnM7IGlmIGVtcHR5LCBubyBmaWx0ZXIgaXNcbiAqICAgICAgICAgICAgIGRvbmUgb24gZXh0ZW5zaW9uczsgJycgZW1wdHkgc3RyaW5nIGRlbm90ZXMgdG8gYWxsb3cgZmlsZXMgd2l0aCBubyBleHRlbnNpb25zLFxuICogICAgICAgICAgICAgb3RoZXIgZXh0ZW5zaW9ucyBhcmUgbGlzdGVkIHdpdGggJy5leHQnIG5vdGF0aW9uIHN1Y2ggYXMgJy5kLnRzJy5cbiAqL1xuZnVuY3Rpb24gZmlsdGVyRmlsZXMoZmlsZXM6IHN0cmluZ1tdLCBleHRzOiBzdHJpbmdbXSA9IFtdKSB7XG4gIGlmIChleHRzLmxlbmd0aCkge1xuICAgIGNvbnN0IGFsbG93Tm9FeHRzID0gZXh0cy5pbmNsdWRlcygnJyk7XG4gICAgZmlsZXMgPSBmaWxlcy5maWx0ZXIoZiA9PiB7XG4gICAgICAvLyBpbmNsdWRlIGZpbGVzIHdpdGggbm8gZXh0ZW5zaW9ucyBpZiBub0V4dCBpcyB0cnVlXG4gICAgICBpZiAoYWxsb3dOb0V4dHMgJiYgIXBhdGguZXh0bmFtZShmKSkgcmV0dXJuIHRydWU7XG4gICAgICAvLyBmaWx0ZXIgZmlsZXMgaW4gZXh0c1xuICAgICAgY29uc3QgbGMgPSBmLnRvTG93ZXJDYXNlKCk7XG4gICAgICBmb3IgKGNvbnN0IGUgb2YgZXh0cykge1xuICAgICAgICBpZiAoZSAmJiBsYy5lbmRzV2l0aChlLnRvTG93ZXJDYXNlKCkpKSB7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9KVxuICB9XG4gIC8vIEZpbHRlciBvdXQgQlVJTEQgZmlsZXMgdGhhdCBjYW1lIHdpdGggdGhlIG5wbSBwYWNrYWdlXG4gIHJldHVybiBmaWxlcy5maWx0ZXIoZmlsZSA9PiB7XG4gICAgY29uc3QgYmFzZW5hbWVVYyA9IHBhdGguYmFzZW5hbWUoZmlsZSkudG9VcHBlckNhc2UoKTtcbiAgICBpZiAoYmFzZW5hbWVVYyA9PT0gJ19CVUlMRCcgfHwgYmFzZW5hbWVVYyA9PT0gJ19CVUlMRC5CQVpFTCcpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIHRydWU7XG4gIH0pO1xufVxuXG4vKipcbiAqIFJldHVybnMgdHJ1ZSBpZiB0aGUgc3BlY2lmaWVkIGBwa2dgIGNvbmZvcm1zIHRvIEFuZ3VsYXIgUGFja2FnZSBGb3JtYXQgKEFQRiksXG4gKiBmYWxzZSBvdGhlcndpc2UuIElmIHRoZSBwYWNrYWdlIGNvbnRhaW5zIGAqLm1ldGFkYXRhLmpzb25gIGFuZCBhXG4gKiBjb3JyZXNwb25kaW5nIHNpYmxpbmcgYC5kLnRzYCBmaWxlLCB0aGVuIHRoZSBwYWNrYWdlIGlzIGNvbnNpZGVyZWQgdG8gYmUgQVBGLlxuICovXG5mdW5jdGlvbiBpc05nQXBmUGFja2FnZShwa2c6IERlcCkge1xuICBjb25zdCBzZXQgPSBuZXcgU2V0KHBrZy5fZmlsZXMpO1xuICBpZiAoc2V0LmhhcygnQU5HVUxBUl9QQUNLQUdFJykpIHtcbiAgICAvLyBUaGlzIGZpbGUgaXMgdXNlZCBieSB0aGUgbnBtL3lhcm5faW5zdGFsbCBydWxlIHRvIGRldGVjdCBBUEYuIFNlZVxuICAgIC8vIGh0dHBzOi8vZ2l0aHViLmNvbS9iYXplbGJ1aWxkL3J1bGVzX25vZGVqcy9pc3N1ZXMvOTI3XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgY29uc3QgbWV0YWRhdGFFeHQgPSAvXFwubWV0YWRhdGFcXC5qc29uJC87XG4gIHJldHVybiBwa2cuX2ZpbGVzLnNvbWUoKGZpbGUpID0+IHtcbiAgICBpZiAobWV0YWRhdGFFeHQudGVzdChmaWxlKSkge1xuICAgICAgY29uc3Qgc2libGluZyA9IGZpbGUucmVwbGFjZShtZXRhZGF0YUV4dCwgJy5kLnRzJyk7XG4gICAgICBpZiAoc2V0LmhhcyhzaWJsaW5nKSkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9KTtcbn1cblxuLyoqXG4gKiBJZiB0aGUgcGFja2FnZSBpcyBpbiB0aGUgQW5ndWxhciBwYWNrYWdlIGZvcm1hdCByZXR1cm5zIGxpc3RcbiAqIG9mIHBhY2thZ2UgZmlsZXMgdGhhdCBlbmQgd2l0aCBgLnVtZC5qc2AsIGAubmdmYWN0b3J5LmpzYCBhbmQgYC5uZ3N1bW1hcnkuanNgLlxuICovXG5mdW5jdGlvbiBnZXROZ0FwZlNjcmlwdHMocGtnOiBEZXApIHtcbiAgcmV0dXJuIGlzTmdBcGZQYWNrYWdlKHBrZykgP1xuICAgICAgZmlsdGVyRmlsZXMocGtnLl9maWxlcywgWycudW1kLmpzJywgJy5uZ2ZhY3RvcnkuanMnLCAnLm5nc3VtbWFyeS5qcyddKSA6XG4gICAgICBbXTtcbn1cblxuLyoqXG4gKiBMb29rcyBmb3IgYSBmaWxlIHdpdGhpbiBhIHBhY2thZ2UgYW5kIHJldHVybnMgaXQgaWYgZm91bmQuXG4gKi9cbmZ1bmN0aW9uIGZpbmRGaWxlKHBrZzogRGVwLCBtOiBzdHJpbmcpIHtcbiAgY29uc3QgbWwgPSBtLnRvTG93ZXJDYXNlKCk7XG4gIGZvciAoY29uc3QgZiBvZiBwa2cuX2ZpbGVzKSB7XG4gICAgaWYgKGYudG9Mb3dlckNhc2UoKSA9PT0gbWwpIHtcbiAgICAgIHJldHVybiBmO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIEdpdmVuIGEgcGtnLCByZXR1cm4gdGhlIHNreWxhcmsgYG5vZGVfbW9kdWxlX2xpYnJhcnlgIHRhcmdldHMgZm9yIHRoZSBwYWNrYWdlLlxuICovXG5mdW5jdGlvbiBwcmludFBhY2thZ2UocGtnOiBEZXApIHtcbiAgY29uc3Qgc291cmNlcyA9IGZpbHRlckZpbGVzKHBrZy5fZmlsZXMsIElOQ0xVREVEX0ZJTEVTKTtcbiAgY29uc3QgZHRzU291cmNlcyA9IGZpbHRlckZpbGVzKHBrZy5fZmlsZXMsIFsnLmQudHMnXSk7XG4gIC8vIFRPRE8oZ21hZ29sYW4pOiBhZGQgVU1EICYgQU1EIHNjcmlwdHMgdG8gc2NyaXB0cyBldmVuIGlmIG5vdCBhbiBBUEYgcGFja2FnZSBfYnV0XyBvbmx5IGlmIHRoZXlcbiAgLy8gYXJlIG5hbWVkP1xuICBjb25zdCBuYW1lZFNvdXJjZXMgPSBnZXROZ0FwZlNjcmlwdHMocGtnKTtcbiAgY29uc3QgZGVwcyA9IFtwa2ddLmNvbmNhdChwa2cuX2RlcGVuZGVuY2llcy5maWx0ZXIoZGVwID0+IGRlcCAhPT0gcGtnICYmICFkZXAuX2lzTmVzdGVkKSk7XG5cbiAgbGV0IG5hbWVkU291cmNlc1N0YXJsYXJrID0gJyc7XG4gIGlmIChuYW1lZFNvdXJjZXMubGVuZ3RoKSB7XG4gICAgbmFtZWRTb3VyY2VzU3RhcmxhcmsgPSBgXG4gICAgIyBzdWJzZXQgb2Ygc3JjcyB0aGF0IGFyZSBqYXZhc2NyaXB0IG5hbWVkLVVNRCBvciBuYW1lZC1BTUQgc2NyaXB0c1xuICAgIG5hbWVkX3NvdXJjZXMgPSBbXG4gICAgICAgICR7bmFtZWRTb3VyY2VzLm1hcCgoZjogc3RyaW5nKSA9PiBgXCIvLzpub2RlX21vZHVsZXMvJHtwa2cuX2Rpcn0vJHtmfVwiLGApLmpvaW4oJ1xcbiAgICAgICAgJyl9XG4gICAgXSxgO1xuICB9XG5cbiAgbGV0IHNyY3NTdGFybGFyayA9ICcnO1xuICBpZiAoc291cmNlcy5sZW5ndGgpIHtcbiAgICBzcmNzU3RhcmxhcmsgPSBgXG4gICAgIyAke3BrZy5fZGlyfSBwYWNrYWdlIGZpbGVzIChhbmQgZmlsZXMgaW4gbmVzdGVkIG5vZGVfbW9kdWxlcylcbiAgICBzcmNzID0gW1xuICAgICAgICAke3NvdXJjZXMubWFwKChmOiBzdHJpbmcpID0+IGBcIi8vOm5vZGVfbW9kdWxlcy8ke3BrZy5fZGlyfS8ke2Z9XCIsYCkuam9pbignXFxuICAgICAgICAnKX1cbiAgICBdLGA7XG4gIH1cblxuICBsZXQgZGVwc1N0YXJsYXJrID0gJyc7XG4gIGlmIChkZXBzLmxlbmd0aCkge1xuICAgIGNvbnN0IGxpc3QgPSBkZXBzLm1hcChkZXAgPT4gYFwiLy8ke2RlcC5fZGlyfToke2RlcC5fbmFtZX1fX2NvbnRlbnRzXCIsYCkuam9pbignXFxuICAgICAgICAnKTtcbiAgICBkZXBzU3RhcmxhcmsgPSBgXG4gICAgIyBmbGF0dGVuZWQgbGlzdCBvZiBkaXJlY3QgYW5kIHRyYW5zaXRpdmUgZGVwZW5kZW5jaWVzIGhvaXN0ZWQgdG8gcm9vdCBieSB0aGUgcGFja2FnZSBtYW5hZ2VyXG4gICAgZGVwcyA9IFtcbiAgICAgICAgJHtsaXN0fVxuICAgIF0sYDtcbiAgfVxuXG4gIGxldCBkdHNTdGFybGFyayA9ICcnO1xuICBpZiAoZHRzU291cmNlcy5sZW5ndGgpIHtcbiAgICBkdHNTdGFybGFyayA9IGBcbiAgICAjICR7cGtnLl9kaXJ9IHBhY2thZ2UgZGVjbGFyYXRpb24gZmlsZXMgKGFuZCBkZWNsYXJhdGlvbiBmaWxlcyBpbiBuZXN0ZWQgbm9kZV9tb2R1bGVzKVxuICAgIHNyY3MgPSBbXG4gICAgICAgICR7ZHRzU291cmNlcy5tYXAoZiA9PiBgXCIvLzpub2RlX21vZHVsZXMvJHtwa2cuX2Rpcn0vJHtmfVwiLGApLmpvaW4oJ1xcbiAgICAgICAgJyl9XG4gICAgXSxgO1xuICB9XG5cbiAgbGV0IHJlc3VsdCA9XG4gICAgICBgbG9hZChcIkBidWlsZF9iYXplbF9ydWxlc19ub2RlanMvL2ludGVybmFsL25wbV9pbnN0YWxsOm5vZGVfbW9kdWxlX2xpYnJhcnkuYnpsXCIsIFwibm9kZV9tb2R1bGVfbGlicmFyeVwiKVxuXG4jIEdlbmVyYXRlZCB0YXJnZXRzIGZvciBucG0gcGFja2FnZSBcIiR7cGtnLl9kaXJ9XCJcbiR7cHJpbnRKc29uKHBrZyl9XG5cbmZpbGVncm91cChcbiAgICBuYW1lID0gXCIke3BrZy5fbmFtZX1fX2ZpbGVzXCIsJHtzcmNzU3Rhcmxhcmt9XG4pXG5cbm5vZGVfbW9kdWxlX2xpYnJhcnkoXG4gICAgbmFtZSA9IFwiJHtwa2cuX25hbWV9XCIsXG4gICAgIyBkaXJlY3Qgc291cmNlcyBsaXN0ZWQgZm9yIHN0cmljdCBkZXBzIHN1cHBvcnRcbiAgICBzcmNzID0gW1wiOiR7cGtnLl9uYW1lfV9fZmlsZXNcIl0sJHtkZXBzU3Rhcmxhcmt9XG4pXG5cbiMgJHtwa2cuX25hbWV9X19jb250ZW50cyB0YXJnZXQgaXMgdXNlZCBhcyBkZXAgZm9yIG1haW4gdGFyZ2V0cyB0byBwcmV2ZW50XG4jIGNpcmN1bGFyIGRlcGVuZGVuY2llcyBlcnJvcnNcbm5vZGVfbW9kdWxlX2xpYnJhcnkoXG4gICAgbmFtZSA9IFwiJHtwa2cuX25hbWV9X19jb250ZW50c1wiLFxuICAgIHNyY3MgPSBbXCI6JHtwa2cuX25hbWV9X19maWxlc1wiXSwke25hbWVkU291cmNlc1N0YXJsYXJrfVxuKVxuXG4jICR7cGtnLl9uYW1lfV9fdHlwaW5ncyBpcyB0aGUgc3Vic2V0IG9mICR7cGtnLl9uYW1lfV9fY29udGVudHMgdGhhdCBhcmUgZGVjbGFyYXRpb25zXG5ub2RlX21vZHVsZV9saWJyYXJ5KFxuICAgIG5hbWUgPSBcIiR7cGtnLl9uYW1lfV9fdHlwaW5nc1wiLCR7ZHRzU3Rhcmxhcmt9XG4pXG5cbmA7XG5cbiAgbGV0IG1haW5FbnRyeVBvaW50ID0gcmVzb2x2ZVBrZ01haW5GaWxlKHBrZylcblxuICAvLyBhZGQgYW4gYG5wbV91bWRfYnVuZGxlYCB0YXJnZXQgdG8gZ2VuZXJhdGUgYW4gVU1EIGJ1bmRsZSBpZiBvbmUgZG9lc1xuICAvLyBub3QgZXhpc3RzXG4gIGlmIChtYWluRW50cnlQb2ludCAmJiAhZmluZEZpbGUocGtnLCBgJHtwa2cuX25hbWV9LnVtZC5qc2ApKSB7XG4gICAgcmVzdWx0ICs9XG4gICAgICAgIGBsb2FkKFwiQGJ1aWxkX2JhemVsX3J1bGVzX25vZGVqcy8vaW50ZXJuYWwvbnBtX2luc3RhbGw6bnBtX3VtZF9idW5kbGUuYnpsXCIsIFwibnBtX3VtZF9idW5kbGVcIilcblxubnBtX3VtZF9idW5kbGUoXG4gICAgbmFtZSA9IFwiJHtwa2cuX25hbWV9X191bWRcIixcbiAgICBwYWNrYWdlX25hbWUgPSBcIiR7cGtnLl9uYW1lfVwiLFxuICAgIGVudHJ5X3BvaW50ID0gXCIvLzpub2RlX21vZHVsZXMvJHtwa2cuX2Rpcn0vJHttYWluRW50cnlQb2ludH1cIixcbiAgICBwYWNrYWdlID0gXCI6JHtwa2cuX25hbWV9XCIsXG4pXG5cbmA7XG4gIH1cblxuICByZXR1cm4gcmVzdWx0O1xufVxuXG5mdW5jdGlvbiBfZmluZEV4ZWN1dGFibGVzKHBrZzogRGVwKSB7XG4gIGNvbnN0IGV4ZWN1dGFibGVzID0gbmV3IE1hcCgpO1xuXG4gIC8vIEZvciByb290IHBhY2thZ2VzLCB0cmFuc2Zvcm0gdGhlIHBrZy5iaW4gZW50cmllc1xuICAvLyBpbnRvIGEgbmV3IE1hcCBjYWxsZWQgX2V4ZWN1dGFibGVzXG4gIC8vIE5PVEU6IHdlIGRvIHRoaXMgb25seSBmb3Igbm9uLWVtcHR5IGJpbiBwYXRoc1xuICBpZiAoaXNWYWxpZEJpblBhdGgocGtnLmJpbikpIHtcbiAgICBpZiAoIXBrZy5faXNOZXN0ZWQpIHtcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KHBrZy5iaW4pKSB7XG4gICAgICAgIGlmIChwa2cuYmluLmxlbmd0aCA9PSAxKSB7XG4gICAgICAgICAgZXhlY3V0YWJsZXMuc2V0KHBrZy5fZGlyLCBjbGVhbnVwQmluUGF0aChwa2cuYmluWzBdKSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gc2hvdWxkIG5vdCBoYXBwZW4sIGJ1dCBpZ25vcmUgaXQgaWYgcHJlc2VudFxuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKHR5cGVvZiBwa2cuYmluID09PSAnc3RyaW5nJykge1xuICAgICAgICBleGVjdXRhYmxlcy5zZXQocGtnLl9kaXIsIGNsZWFudXBCaW5QYXRoKHBrZy5iaW4pKTtcbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIHBrZy5iaW4gPT09ICdvYmplY3QnKSB7XG4gICAgICAgIGZvciAobGV0IGtleSBpbiBwa2cuYmluKSB7XG4gICAgICAgICAgaWYgKGlzVmFsaWRCaW5QYXRoU3RyaW5nVmFsdWUocGtnLmJpbltrZXldKSkge1xuICAgICAgICAgICAgZXhlY3V0YWJsZXMuc2V0KGtleSwgY2xlYW51cEJpblBhdGgocGtnLmJpbltrZXldKSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGV4ZWN1dGFibGVzO1xufVxuXG4vLyBIYW5kbGUgYWRkaXRpb25hbEF0dHJpYnV0ZXMgb2YgZm9ybWF0OlxuLy8gYGBgXG4vLyBcImJhemVsQmluXCI6IHtcbi8vICAgXCJuZ2Mtd3JhcHBlZFwiOiB7XG4vLyAgICAgXCJhZGRpdGlvbmFsQXR0cmlidXRlc1wiOiB7XG4vLyAgICAgICBcImNvbmZpZ3VyYXRpb25fZW52X3ZhcnNcIjogXCJbXFxcImNvbXBpbGVcXFwiXVwiXG4vLyAgIH1cbi8vIH0sXG4vLyBgYGBcbmZ1bmN0aW9uIGFkZGl0aW9uYWxBdHRyaWJ1dGVzKHBrZzogRGVwLCBuYW1lOiBzdHJpbmcpIHtcbiAgbGV0IGFkZGl0aW9uYWxBdHRyaWJ1dGVzID0gJyc7XG4gIGlmIChwa2cuYmF6ZWxCaW4gJiYgcGtnLmJhemVsQmluW25hbWVdICYmIHBrZy5iYXplbEJpbltuYW1lXS5hZGRpdGlvbmFsQXR0cmlidXRlcykge1xuICAgIGNvbnN0IGF0dHJzID0gcGtnLmJhemVsQmluW25hbWVdLmFkZGl0aW9uYWxBdHRyaWJ1dGVzO1xuICAgIGZvciAoY29uc3QgYXR0ck5hbWUgb2YgT2JqZWN0LmtleXMoYXR0cnMpKSB7XG4gICAgICBjb25zdCBhdHRyVmFsdWUgPSBhdHRyc1thdHRyTmFtZV07XG4gICAgICBhZGRpdGlvbmFsQXR0cmlidXRlcyArPSBgXFxuICAgICR7YXR0ck5hbWV9ID0gJHthdHRyVmFsdWV9LGA7XG4gICAgfVxuICB9XG4gIHJldHVybiBhZGRpdGlvbmFsQXR0cmlidXRlcztcbn1cblxuLyoqXG4gKiBHaXZlbiBhIHBrZywgcmV0dXJuIHRoZSBza3lsYXJrIG5vZGVqc19iaW5hcnkgdGFyZ2V0cyBmb3IgdGhlIHBhY2thZ2UuXG4gKi9cbmZ1bmN0aW9uIHByaW50UGFja2FnZUJpbihwa2c6IERlcCkge1xuICBsZXQgcmVzdWx0ID0gJyc7XG4gIGNvbnN0IGV4ZWN1dGFibGVzID0gX2ZpbmRFeGVjdXRhYmxlcyhwa2cpO1xuICBpZiAoZXhlY3V0YWJsZXMuc2l6ZSkge1xuICAgIHJlc3VsdCA9IGBsb2FkKFwiQGJ1aWxkX2JhemVsX3J1bGVzX25vZGVqcy8vOmluZGV4LmJ6bFwiLCBcIm5vZGVqc19iaW5hcnlcIilcblxuYDtcbiAgICBjb25zdCBkYXRhID0gW2AvLyR7cGtnLl9kaXJ9OiR7cGtnLl9uYW1lfWBdO1xuICAgIGlmIChwa2cuX2R5bmFtaWNEZXBlbmRlbmNpZXMpIHtcbiAgICAgIGRhdGEucHVzaCguLi5wa2cuX2R5bmFtaWNEZXBlbmRlbmNpZXMpO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgW25hbWUsIHBhdGhdIG9mIGV4ZWN1dGFibGVzLmVudHJpZXMoKSkge1xuICAgICAgcmVzdWx0ICs9IGAjIFdpcmUgdXAgdGhlIFxcYGJpblxcYCBlbnRyeSBcXGAke25hbWV9XFxgXG5ub2RlanNfYmluYXJ5KFxuICAgIG5hbWUgPSBcIiR7bmFtZX1cIixcbiAgICBlbnRyeV9wb2ludCA9IFwiLy86bm9kZV9tb2R1bGVzLyR7cGtnLl9kaXJ9LyR7cGF0aH1cIixcbiAgICBpbnN0YWxsX3NvdXJjZV9tYXBfc3VwcG9ydCA9IEZhbHNlLFxuICAgIGRhdGEgPSBbJHtkYXRhLm1hcChwID0+IGBcIiR7cH1cImApLmpvaW4oJywgJyl9XSwke2FkZGl0aW9uYWxBdHRyaWJ1dGVzKHBrZywgbmFtZSl9XG4pXG5cbmA7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuZnVuY3Rpb24gcHJpbnRJbmRleEJ6bChwa2c6IERlcCkge1xuICBsZXQgcmVzdWx0ID0gJyc7XG4gIGNvbnN0IGV4ZWN1dGFibGVzID0gX2ZpbmRFeGVjdXRhYmxlcyhwa2cpO1xuICBpZiAoZXhlY3V0YWJsZXMuc2l6ZSkge1xuICAgIHJlc3VsdCA9IGBsb2FkKFwiQGJ1aWxkX2JhemVsX3J1bGVzX25vZGVqcy8vOmluZGV4LmJ6bFwiLCBcIm5vZGVqc19iaW5hcnlcIiwgXCJucG1fcGFja2FnZV9iaW5cIilcblxuYDtcbiAgICBjb25zdCBkYXRhID0gW2BAJHtXT1JLU1BBQ0V9Ly8ke3BrZy5fZGlyfToke3BrZy5fbmFtZX1gXTtcbiAgICBpZiAocGtnLl9keW5hbWljRGVwZW5kZW5jaWVzKSB7XG4gICAgICBkYXRhLnB1c2goLi4ucGtnLl9keW5hbWljRGVwZW5kZW5jaWVzKTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IFtuYW1lLCBwYXRoXSBvZiBleGVjdXRhYmxlcy5lbnRyaWVzKCkpIHtcbiAgICAgIHJlc3VsdCA9IGAke3Jlc3VsdH1cblxuIyBHZW5lcmF0ZWQgaGVscGVyIG1hY3JvIHRvIGNhbGwgJHtuYW1lfVxuZGVmICR7bmFtZS5yZXBsYWNlKC8tL2csICdfJyl9KCoqa3dhcmdzKTpcbiAgICBvdXRwdXRfZGlyID0ga3dhcmdzLnBvcChcIm91dHB1dF9kaXJcIiwgRmFsc2UpXG4gICAgaWYgXCJvdXRzXCIgaW4ga3dhcmdzIG9yIG91dHB1dF9kaXI6XG4gICAgICAgIG5wbV9wYWNrYWdlX2Jpbih0b29sID0gXCJAJHtXT1JLU1BBQ0V9Ly8ke3BrZy5fZGlyfS9iaW46JHtcbiAgICAgICAgICBuYW1lfVwiLCBvdXRwdXRfZGlyID0gb3V0cHV0X2RpciwgKiprd2FyZ3MpXG4gICAgZWxzZTpcbiAgICAgICAgbm9kZWpzX2JpbmFyeShcbiAgICAgICAgICAgIGVudHJ5X3BvaW50ID0gXCJAJHtXT1JLU1BBQ0V9Ly86bm9kZV9tb2R1bGVzLyR7cGtnLl9kaXJ9LyR7cGF0aH1cIixcbiAgICAgICAgICAgIGluc3RhbGxfc291cmNlX21hcF9zdXBwb3J0ID0gRmFsc2UsXG4gICAgICAgICAgICBkYXRhID0gWyR7ZGF0YS5tYXAocCA9PiBgXCIke3B9XCJgKS5qb2luKCcsICcpfV0gKyBrd2FyZ3MucG9wKFwiZGF0YVwiLCBbXSksJHtcbiAgICAgICAgICBhZGRpdGlvbmFsQXR0cmlidXRlcyhwa2csIG5hbWUpfVxuICAgICAgICAgICAgKiprd2FyZ3NcbiAgICAgICAgKVxuICBgO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG50eXBlIERlcCA9IHtcbiAgX2Rpcjogc3RyaW5nLFxuICBfaXNOZXN0ZWQ6IGJvb2xlYW4sXG4gIF9kZXBlbmRlbmNpZXM6IERlcFtdLFxuICBfZmlsZXM6IHN0cmluZ1tdLFxuICBbazogc3RyaW5nXTogYW55XG59XG5cbi8qKlxuICogR2l2ZW4gYSBzY29wZSwgcmV0dXJuIHRoZSBza3lsYXJrIGBub2RlX21vZHVsZV9saWJyYXJ5YCB0YXJnZXQgZm9yIHRoZSBzY29wZS5cbiAqL1xuZnVuY3Rpb24gcHJpbnRTY29wZShzY29wZTogc3RyaW5nLCBwa2dzOiBEZXBbXSkge1xuICBwa2dzID0gcGtncy5maWx0ZXIocGtnID0+ICFwa2cuX2lzTmVzdGVkICYmIHBrZy5fZGlyLnN0YXJ0c1dpdGgoYCR7c2NvcGV9L2ApKTtcbiAgbGV0IGRlcHM6IERlcFtdID0gW107XG4gIHBrZ3MuZm9yRWFjaChwa2cgPT4ge1xuICAgIGRlcHMgPSBkZXBzLmNvbmNhdChwa2cuX2RlcGVuZGVuY2llcy5maWx0ZXIoZGVwID0+ICFkZXAuX2lzTmVzdGVkICYmICFwa2dzLmluY2x1ZGVzKHBrZykpKTtcbiAgfSk7XG4gIC8vIGZpbHRlciBvdXQgZHVwbGljYXRlIGRlcHNcbiAgZGVwcyA9IFsuLi5wa2dzLCAuLi5uZXcgU2V0KGRlcHMpXTtcblxuICBsZXQgc3Jjc1N0YXJsYXJrID0gJyc7XG4gIGlmIChkZXBzLmxlbmd0aCkge1xuICAgIGNvbnN0IGxpc3QgPSBkZXBzLm1hcChkZXAgPT4gYFwiLy8ke2RlcC5fZGlyfToke2RlcC5fbmFtZX1fX2ZpbGVzXCIsYCkuam9pbignXFxuICAgICAgICAnKTtcbiAgICBzcmNzU3RhcmxhcmsgPSBgXG4gICAgIyBkaXJlY3Qgc291cmNlcyBsaXN0ZWQgZm9yIHN0cmljdCBkZXBzIHN1cHBvcnRcbiAgICBzcmNzID0gW1xuICAgICAgICAke2xpc3R9XG4gICAgXSxgO1xuICB9XG5cbiAgbGV0IGRlcHNTdGFybGFyayA9ICcnO1xuICBpZiAoZGVwcy5sZW5ndGgpIHtcbiAgICBjb25zdCBsaXN0ID0gZGVwcy5tYXAoZGVwID0+IGBcIi8vJHtkZXAuX2Rpcn06JHtkZXAuX25hbWV9X19jb250ZW50c1wiLGApLmpvaW4oJ1xcbiAgICAgICAgJyk7XG4gICAgZGVwc1N0YXJsYXJrID0gYFxuICAgICMgZmxhdHRlbmVkIGxpc3Qgb2YgZGlyZWN0IGFuZCB0cmFuc2l0aXZlIGRlcGVuZGVuY2llcyBob2lzdGVkIHRvIHJvb3QgYnkgdGhlIHBhY2thZ2UgbWFuYWdlclxuICAgIGRlcHMgPSBbXG4gICAgICAgICR7bGlzdH1cbiAgICBdLGA7XG4gIH1cblxuICByZXR1cm4gYGxvYWQoXCJAYnVpbGRfYmF6ZWxfcnVsZXNfbm9kZWpzLy9pbnRlcm5hbC9ucG1faW5zdGFsbDpub2RlX21vZHVsZV9saWJyYXJ5LmJ6bFwiLCBcIm5vZGVfbW9kdWxlX2xpYnJhcnlcIilcblxuIyBHZW5lcmF0ZWQgdGFyZ2V0IGZvciBucG0gc2NvcGUgJHtzY29wZX1cbm5vZGVfbW9kdWxlX2xpYnJhcnkoXG4gICAgbmFtZSA9IFwiJHtzY29wZX1cIiwke3NyY3NTdGFybGFya30ke2RlcHNTdGFybGFya31cbilcblxuYDtcbn1cbiJdfQ==