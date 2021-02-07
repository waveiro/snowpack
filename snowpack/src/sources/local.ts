import crypto from 'crypto';
import {install as esinstall, resolveEntrypoint} from 'esinstall';
import projectCacheDir from 'find-cache-dir';
import findUp from 'find-up';
import {existsSync, promises as fs, readFileSync} from 'fs';
import path from 'path';
import rimraf from 'rimraf';
import util from 'util';
import {logger} from '../logger';
import {transformEsmImports} from '../rewrite-imports';
import {CommandOptions, PackageSource, SnowpackConfig} from '../types';
import {GLOBAL_CACHE_DIR} from '../util';

const PROJECT_CACHE_DIR =
  projectCacheDir({name: 'snowpack'}) ||
  // If `projectCacheDir()` is null, no node_modules directory exists.
  // Use the current path (hashed) to create a cache entry in the global cache instead.
  // Because this is specifically for dependencies, this fallback should rarely be used.
  path.join(GLOBAL_CACHE_DIR, crypto.createHash('md5').update(process.cwd()).digest('hex'));

const DEV_DEPENDENCIES_DIR = path.join(PROJECT_CACHE_DIR, process.env.NODE_ENV || 'development');

// A bit of a hack: we keep this in local state and populate it
// during the "prepare" call. Useful so that we don't need to pass
// this implementation detail around outside of this interface.
// Can't add it to the exported interface due to TS.
let config: SnowpackConfig;

const allHashes: Record<string, string> = {};
/**
 * Local Package Source: A generic interface through which Snowpack
 * interacts with esinstall and your locally installed dependencies.
 */
export default {
  async load(id: string): Promise<Buffer> {
    const [, packageInfo, hash, ...specParts] = id.split('/');
    const packageInfoParts = packageInfo.split('@');
    const packageVersion = packageInfoParts.pop()!;
    const packageName = packageInfoParts.join('@');
    const spec = specParts.join('/');
    const entrypoint = allHashes[hash];
    const installDest = path.join(DEV_DEPENDENCIES_DIR, packageInfo);
    let installEntrypoints = [spec];
    let dependencyFileLoc: string | undefined;
    console.time(spec);
    if (existsSync(installDest)) {
      const importMap = JSON.parse(
        (await fs.readFile(path.join(installDest, 'import-map.json'), 'utf8'))!,
      );
      installEntrypoints = Object.keys(importMap.imports);
      if (importMap.imports[spec]) {
        dependencyFileLoc = path.join(installDest, importMap.imports[spec]);
      } else {
        installEntrypoints.push(spec);
      }
    }
    const entrypointPackageManifestLoc = (await findUp('package.json', {
      cwd: path.dirname(entrypoint),
    })) as string;
    const entrypointPackageManifest = JSON.parse(
      await fs.readFile(entrypointPackageManifestLoc, 'utf8'),
    );
    if (!dependencyFileLoc) {
      // TODO: external should be a function in esinstall
      const external = [
        ...Object.keys(entrypointPackageManifest.dependencies || {}),
        ...Object.keys(entrypointPackageManifest.devDependencies || {}),
        ...Object.keys(entrypointPackageManifest.peerDependencies || {}),
      ];

      const finalResult = await esinstall(installEntrypoints, {
        dest: installDest,
        env: {NODE_ENV: process.env.NODE_ENV || 'development'},
        treeshake: false,
        cwd: entrypointPackageManifestLoc,
        external,
        externalEsm: external,
        logger: {
          debug: (...args: [any, ...any[]]) => logger.debug(util.format(...args)),
          log: (...args: [any, ...any[]]) => logger.info(util.format(...args)),
          warn: (...args: [any, ...any[]]) => logger.warn(util.format(...args)),
          error: (...args: [any, ...any[]]) => logger.error(util.format(...args)),
        },
      });
      dependencyFileLoc = path.join(installDest, finalResult.importMap.imports[spec]);
    }
    console.timeEnd(spec);
    const installedPackageCode = await fs.readFile(dependencyFileLoc!, 'utf8');
    // TODO: Always pass the result through our normal build pipeline, for unbundled packages and such
    const processedCode = await transformEsmImports(
      installedPackageCode,
      (_spec) => this.resolvePackageImport(entrypointPackageManifestLoc, _spec, config) as string,
    );
    return Buffer.from(processedCode);
  },

  modifyBuildInstallOptions({installOptions, config}) {
    if (config.packageOptions.source !== 'local') {
      return installOptions;
    }
    installOptions.cwd = config.root;
    installOptions.rollup = config.packageOptions.rollup;
    installOptions.sourcemap = config.buildOptions.sourcemap;
    installOptions.polyfillNode = config.packageOptions.polyfillNode;
    installOptions.packageLookupFields = config.packageOptions.packageLookupFields;
    installOptions.packageExportLookupFields = config.packageOptions.packageExportLookupFields;
    return installOptions;
  },

  async prepare(commandOptions: CommandOptions) {
    config = commandOptions.config;
    // const {config} = commandOptions;
    // Set the proper install options, in case an install is needed.
    // logger.debug(`Using cache folder: ${path.relative(config.root, DEV_DEPENDENCIES_DIR)}`);
    // installOptions = merge(commandOptions.config.packageOptions as PackageSourceLocal, {
    //   dest: DEV_DEPENDENCIES_DIR,
    //   env: {NODE_ENV: process.env.NODE_ENV || 'development'},
    //   treeshake: false,
    // });
    // Start with a fresh install of your dependencies, if needed.
    // const dependencyImportMapLoc = path.join(DEV_DEPENDENCIES_DIR, 'import-map.json');
    // let dependencyImportMap = {imports: {}};
    // try {
    //   dependencyImportMap = JSON.parse(
    //     await fs.readFile(dependencyImportMapLoc, {encoding: 'utf8'}),
    //   );
    // } catch (err) {
    //   // no import-map found, safe to ignore
    // }
    // if (!(await checkLockfileHash(DEV_DEPENDENCIES_DIR)) || !existsSync(dependencyImportMapLoc)) {
    //   logger.debug('Cache out of date or missing. Updating...');
    //   // const installResult = await installDependencies(config);
    //   // dependencyImportMap = installResult?.importMap || {imports: {}};
    // } else {
    //   logger.debug(`Cache up-to-date. Using existing cache`);
    // }
  },

  resolvePackageImport(source: string, spec: string, config: SnowpackConfig): string | false {
    const entrypoint = resolveEntrypoint(spec, {
      cwd: path.dirname(source),
      packageLookupFields: [],
    });
    const entrypointPackageManifestLoc = findUp.sync('package.json', {
      cwd: path.dirname(entrypoint),
    });
    const entrypointPackageManifest = JSON.parse(
      readFileSync(entrypointPackageManifestLoc!, 'utf8'),
    );
    const hash = crypto.createHash('md5').update(entrypoint).digest('hex');
    allHashes[hash] = entrypoint;
    return path.posix.join(
      config.buildOptions.metaUrlPath,
      'pkg',
      'local',
      `${entrypointPackageManifest.name}@${entrypointPackageManifest.version}`,
      hash,
      spec,
    );
  },

  // async recoverMissingPackageImport(_, config): Promise<ImportMap> {
  //   logger.info(colors.yellow('Dependency cache out of date. Updating...'));
  //   const installResult = await installDependencies(config);
  //   const dependencyImportMap = installResult!.importMap;
  //   return dependencyImportMap;
  // },

  clearCache() {
    return rimraf.sync(PROJECT_CACHE_DIR);
  },

  getCacheFolder() {
    return PROJECT_CACHE_DIR;
  },
} as PackageSource;
