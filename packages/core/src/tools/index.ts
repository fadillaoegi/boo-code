import { createRegistry } from '../domain/tool.ts'
import { bashTool } from './bash.ts'
import { editFileTool } from './editFile.ts'
import { listDirTool } from './listDir.ts'
import { readFileTool } from './readFile.ts'
import { writeFileTool } from './writeFile.ts'

export const defaultTools = [readFileTool, listDirTool, writeFileTool, editFileTool, bashTool]

export function createDefaultRegistry() {
  return createRegistry(defaultTools as never)
}

export { bashTool, editFileTool, listDirTool, readFileTool, writeFileTool }
export { resolveInWorkspace, WorkspaceError } from './workspace.ts'
