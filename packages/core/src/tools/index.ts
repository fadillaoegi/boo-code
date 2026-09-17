import { createRegistry } from '../domain/tool.ts'
import { bashTool } from './bash.ts'
import { editFileTool } from './editFile.ts'
import { globTool } from './glob.ts'
import { grepTool } from './grep.ts'
import { listDirTool } from './listDir.ts'
import { readFileTool } from './readFile.ts'
import { writeFileTool } from './writeFile.ts'

export const defaultTools = [readFileTool, listDirTool, globTool, grepTool, writeFileTool, editFileTool, bashTool]

export function createDefaultRegistry() {
  return createRegistry(defaultTools as never)
}

export { bashTool, editFileTool, globTool, grepTool, listDirTool, readFileTool, writeFileTool }
export { resolveInWorkspace, WorkspaceError } from './workspace.ts'
export { isSensitivePath, sensitiveRefusal } from './secrets.ts'
