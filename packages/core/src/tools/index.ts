import { createRegistry } from '../domain/tool.ts'
import { bashTool } from './bash.ts'
import { bashKillTool, bashOutputTool } from './bashOutput.ts'
import { editFileTool } from './editFile.ts'
import { globTool } from './glob.ts'
import { grepTool } from './grep.ts'
import { listDirTool } from './listDir.ts'
import { readFileTool } from './readFile.ts'
import { writeFileTool } from './writeFile.ts'

export const defaultTools = [readFileTool, listDirTool, globTool, grepTool, writeFileTool, editFileTool, bashTool, bashOutputTool, bashKillTool]

export function createDefaultRegistry() {
  return createRegistry(defaultTools as never)
}

export { bashKillTool, bashOutputTool, bashTool, editFileTool, globTool, grepTool, listDirTool, readFileTool, writeFileTool }
export { resolveInWorkspace, WorkspaceError } from './workspace.ts'
export { isSensitivePath, sensitiveRefusal } from './secrets.ts'
export { backgroundProcesses, BackgroundProcesses } from './background.ts'
export { cleanOutput, OutputBuffer, resolveShell, runCommand } from './shell.ts'
