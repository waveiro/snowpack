import {PackageSource} from '../types';
import {BUILD_CACHE} from '../util';
import localPackageSource from './local';
import remotePackageSource from './remote';

export async function clearCache() {
  return Promise.all([localPackageSource.clearCache(), remotePackageSource.clearCache()]);
}

export function getPackageSource(source: 'remote' | 'local'): PackageSource {
  return source === 'local' ? localPackageSource : remotePackageSource;
}
