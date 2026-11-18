import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 运行期数据（项目、模型密钥）默认写在本机 data/；
 *  设置 STUDIO_DATA_DIR 可整体改到临时目录，便于自检隔离、也便于不把密钥写进程序目录。 */
export const DATA_ROOT = process.env.STUDIO_DATA_DIR
  ? path.resolve(process.env.STUDIO_DATA_DIR)
  : path.join(ROOT, 'data');

export const PROJECT_DIR = path.join(DATA_ROOT, 'projects');
export const CONFIG_FILE = path.join(DATA_ROOT, 'model-config.json');
