#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import os from 'os';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';
import { spawn } from 'child_process';
import * as url from 'url';

// Handle workspace setup where node_modules might be hoisted
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let rgPath: string | undefined;
try {
  // Try to import from @vscode/ripgrep
  const ripgrepModule = await import('@vscode/ripgrep');
  rgPath = ripgrepModule.rgPath;
} catch (e) {
  // Fallback to finding it manually in case of workspace setup
  const possiblePaths = [
    path.join(__dirname, '../../../node_modules/@vscode/ripgrep/bin/rg'),
    path.join(__dirname, '../node_modules/@vscode/ripgrep/bin/rg'),
    path.join(__dirname, '../../node_modules/@vscode/ripgrep/bin/rg'),
  ];
  
  for (const p of possiblePaths) {
    try {
      await fs.access(p, fs.constants.X_OK);
      rgPath = p;
      break;
    } catch {}
  }
  
  if (!rgPath) {
    console.error('Could not find ripgrep binary');
  }
}

// Command line argument parsing
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: mcp-server-text-editor <allowed-directory> [additional-directories...]");
  process.exit(1);
}

// Normalize all paths consistently
function normalizePath(p: string): string {
  return path.normalize(p);
}

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

// Store allowed directories in normalized form
const allowedDirectories = args.map(dir =>
  normalizePath(path.resolve(expandHome(dir)))
);

// Validate that all directories exist and are accessible
await Promise.all(args.map(async (dir) => {
  try {
    const stats = await fs.stat(expandHome(dir));
    if (!stats.isDirectory()) {
      console.error(`Error: ${dir} is not a directory`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error accessing directory ${dir}:`, error);
    process.exit(1);
  }
}));

// Edit history for undo functionality
const editHistory = new Map<string, string[]>();
const MAX_HISTORY_SIZE = 10;

// Security utilities
async function validatePath(requestedPath: string): Promise<string> {
  const expandedPath = expandHome(requestedPath);
  const absolute = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(process.cwd(), expandedPath);

  const normalizedRequested = normalizePath(absolute);

  // Check if path is within allowed directories
  const isAllowed = allowedDirectories.some(dir => normalizedRequested.startsWith(dir));
  if (!isAllowed) {
    throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(', ')}`);
  }

  // Handle symlinks by checking their real path
  try {
    const realPath = await fs.realpath(absolute);
    const normalizedReal = normalizePath(realPath);
    const isRealPathAllowed = allowedDirectories.some(dir => normalizedReal.startsWith(dir));
    if (!isRealPathAllowed) {
      throw new Error("Access denied - symlink target outside allowed directories");
    }
    return realPath;
  } catch (error) {
    // For new files that don't exist yet, verify parent directory
    const parentDir = path.dirname(absolute);
    try {
      const realParentPath = await fs.realpath(parentDir);
      const normalizedParent = normalizePath(realParentPath);
      const isParentAllowed = allowedDirectories.some(dir => normalizedParent.startsWith(dir));
      if (!isParentAllowed) {
        throw new Error("Access denied - parent directory outside allowed directories");
      }
      return absolute;
    } catch {
      throw new Error(`Parent directory does not exist: ${parentDir}`);
    }
  }
}

const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

// Alternative schema for str_replace style
const StrReplaceArgsSchema = z.object({
  path: z.string(),
  old_str: z.string().describe('Text to search for - must match exactly'),
  new_str: z.string().describe('Text to replace with')
});

// Command-based schema for more complex operations
const CommandArgsSchema = z.object({
  command: z.enum(['str_replace', 'insert', 'undo_edit']),
  path: z.string(),
  old_str: z.string().optional(),
  new_str: z.string().optional(),
  insert_line: z.number().optional(),
});

const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

const DirectoryTreeArgsSchema = z.object({
  path: z.string(),
});

const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  excludePatterns: z.array(z.string()).optional().default([])
});

const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

// View schema for compatibility
const ViewArgsSchema = z.object({
  path: z.string(),
  view_range: z.array(z.number()).optional().describe('[start_line, end_line] - 1-indexed, inclusive')
});

// Insert schema
const InsertArgsSchema = z.object({
  path: z.string(),
  insert_line: z.number().describe('Line number after which to insert (0 for beginning)'),
  new_str: z.string().describe('Text to insert')
});

// Remove/Delete file schema
const RemoveFileArgsSchema = z.object({
  path: z.string()
});

const TextSearchArgsSchema = z.object({
  path: z.string(),
  search: z.string(),
  isRegex: z.boolean().optional().default(false),
  matchCase: z.boolean().optional().default(false),
  wholeWord: z.boolean().optional().default(false),
  includePatterns: z.array(z.string()).optional().default([]),
  excludePatterns: z.array(z.string()).optional().default([]),
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

interface RipgrepOptions {
  root: string;
  query: string;
  isRegex?: boolean;
  matchCase?: boolean;
  wholeWord?: boolean;
  includes?: string[];
  excludes?: string[];
  target?: string; // Optional target path (file or directory)
}

async function runRipgrep(opts: RipgrepOptions): Promise<string[]> {
  const {
    root,
    query,
    isRegex = false,
    matchCase = false,
    wholeWord = false,
    includes = [],
    excludes = [],
    target = '.',
  } = opts;

  if (!rgPath) {
    throw new Error('Ripgrep binary not found. Please ensure @vscode/ripgrep is properly installed.');
  }

  const args = [
    '--json',
    '--line-number',
    '--column',
    matchCase ? '' : '--ignore-case',
    wholeWord ? '--word-regexp' : '',
    isRegex ? '' : '--fixed-strings',
    ...includes.flatMap(p => ['-g', p]),
    ...excludes.flatMap(p => ['-g', '!' + p]),
    '--',
    query,
    target,
  ].filter(Boolean);

  console.error(`[search_text] Running ripgrep in ${root} with args:`, args);

  return new Promise((resolve, reject) => {
    const proc = spawn(rgPath, args, { cwd: root });

    const hits: string[] = [];
    let stderrData = '';
    
    proc.stdout.on('data', chunk => {
      const lines = chunk.toString().split('\n').filter((line: string) => line.trim());
      for (const line of lines) {
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'match') {
            const { path, line_number, lines } = evt.data;
            const textLine = lines.text || '';
            hits.push(`${path.text}:${line_number}:${textLine.trim()}`);
          }
        } catch (e) {
          console.error('[search_text] Error parsing ripgrep output:', line, e);
        }
      }
    });

    proc.stderr.on('data', data => {
      stderrData += data.toString();
    });

    proc.on('error', err => {
      console.error('[search_text] Error spawning ripgrep:', err);
      reject(err);
    });

    proc.on('close', code => {
      if (stderrData) {
        console.error('[search_text] Ripgrep stderr:', stderrData);
      }
      if (code === 0 || code === 1) {
        resolve(hits);
      } else {
        reject(new Error(`ripgrep exited with code ${code}: ${stderrData}`));
      }
    });
  });
}

// Server setup
const server = new Server(
  {
    name: "text-editor-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Tool implementations
async function getFileStats(filePath: string): Promise<FileInfo> {
  const stats = await fs.stat(filePath);
  return {
    size: stats.size,
    created: stats.birthtime,
    modified: stats.mtime,
    accessed: stats.atime,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    permissions: stats.mode.toString(8).slice(-3),
  };
}

async function searchFiles(
  rootPath: string,
  pattern: string,
  excludePatterns: string[] = []
): Promise<string[]> {
  const results: string[] = [];

  async function search(currentPath: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      try {
        // Validate each path before processing
        await validatePath(fullPath);

        // Check if path matches any exclude pattern
        const relativePath = path.relative(rootPath, fullPath);
        const shouldExclude = excludePatterns.some(pattern => {
          const globPattern = pattern.includes('*') ? pattern : `**/${pattern}/**`;
          return minimatch(relativePath, globPattern, { dot: true });
        });

        if (shouldExclude) {
          continue;
        }

        if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
          results.push(fullPath);
        }

        if (entry.isDirectory()) {
          await search(fullPath);
        }
      } catch (error) {
        // Skip invalid paths during search
        continue;
      }
    }
  }

  await search(rootPath);
  return results;
}

// file editing and diffing utilities
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function createUnifiedDiff(originalContent: string, newContent: string, filepath: string = 'file'): string {
  // Ensure consistent line endings for diff
  const normalizedOriginal = normalizeLineEndings(originalContent);
  const normalizedNew = normalizeLineEndings(newContent);

  return createTwoFilesPatch(
    filepath,
    filepath,
    normalizedOriginal,
    normalizedNew,
    'original',
    'modified'
  );
}

// Save content to history before making changes
async function saveToHistory(filePath: string, content: string) {
  const history = editHistory.get(filePath) || [];
  history.push(content);
  
  // Keep only the last MAX_HISTORY_SIZE versions
  if (history.length > MAX_HISTORY_SIZE) {
    history.shift();
  }
  
  editHistory.set(filePath, history);
}

async function applyFileEdits(
  filePath: string,
  edits: Array<{oldText: string, newText: string}>,
  dryRun = false
): Promise<string> {
  // Read file content and normalize line endings
  const content = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));
  
  // Save to history before making changes
  if (!dryRun) {
    await saveToHistory(filePath, content);
  }

  // Apply edits sequentially
  let modifiedContent = content;
  for (const edit of edits) {
    const normalizedOld = normalizeLineEndings(edit.oldText);
    const normalizedNew = normalizeLineEndings(edit.newText);

    // If exact match exists, use it
    if (modifiedContent.includes(normalizedOld)) {
      modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
      continue;
    }

    // Otherwise, try line-by-line matching with flexibility for whitespace
    const oldLines = normalizedOld.split('\n');
    const contentLines = modifiedContent.split('\n');
    let matchFound = false;

    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      const potentialMatch = contentLines.slice(i, i + oldLines.length);

      // Compare lines with normalized whitespace
      const isMatch = oldLines.every((oldLine, j) => {
        const contentLine = potentialMatch[j];
        return oldLine.trim() === contentLine.trim();
      });

      if (isMatch) {
        // Preserve original indentation of first line
        const originalIndent = contentLines[i].match(/^\s*/)?.[0] || '';
        const newLines = normalizedNew.split('\n').map((line, j) => {
          if (j === 0) return originalIndent + line.trimStart();
          // For subsequent lines, try to preserve relative indentation
          const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
          const newIndent = line.match(/^\s*/)?.[0] || '';
          if (oldIndent && newIndent) {
            const relativeIndent = newIndent.length - oldIndent.length;
            return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
          }
          return line;
        });

        contentLines.splice(i, oldLines.length, ...newLines);
        modifiedContent = contentLines.join('\n');
        matchFound = true;
        break;
      }
    }

    if (!matchFound) {
      throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
    }
  }

  // Create unified diff
  const diff = createUnifiedDiff(content, modifiedContent, filePath);

  // Format diff with appropriate number of backticks
  let numBackticks = 3;
  while (diff.includes('`'.repeat(numBackticks))) {
    numBackticks++;
  }
  const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;

  if (!dryRun) {
    await fs.writeFile(filePath, modifiedContent, 'utf-8');
  }

  return formattedDiff;
}

// Insert text at a specific line
async function insertAtLine(filePath: string, insertLine: number, newText: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf-8');
  await saveToHistory(filePath, content);
  
  const lines = content.split('\n');
  
  // Handle insertion at beginning (line 0)
  if (insertLine === 0) {
    lines.unshift(newText);
  } else {
    // Insert after the specified line
    const actualLine = Math.min(insertLine, lines.length);
    lines.splice(actualLine, 0, newText);
  }
  
  const modifiedContent = lines.join('\n');
  await fs.writeFile(filePath, modifiedContent, 'utf-8');
  
  // Create diff
  const diff = createUnifiedDiff(content, modifiedContent, filePath);
  let numBackticks = 3;
  while (diff.includes('`'.repeat(numBackticks))) {
    numBackticks++;
  }
  return `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // Alternative tool names that align with API training
      {
        name: "str_replace_editor",
        description:
          "Multi-command file editor supporting string replacement, insertion, and undo. " +
          "Supports three commands: 'str_replace' for text replacement, 'insert' for adding text at specific lines, " +
          "and 'undo_edit' to revert the last change. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(CommandArgsSchema) as ToolInput,
      },
      {
        name: "str_replace_based_edit_tool",
        description:
          "String replacement based file editing tool. Searches for exact text matches and " +
          "replaces them with new content. Useful for making precise edits to files. " +
          "Only works within allowed directories.",
        inputSchema: zodToJsonSchema(StrReplaceArgsSchema) as ToolInput,
      },
      {
        name: "view",
        description:
          "View the contents of a file or directory. Can read entire files or specific line ranges. " +
          "If path is a directory, lists its contents. This provides compatibility with the " +
          "text editor protocol. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ViewArgsSchema) as ToolInput,
      },
      {
        name: "create",
        description:
          "Create a new file with specified content. " +
          "that emphasizes file creation. Will overwrite if file exists. " +
          "Try to consider putting new code where it should go before making a new file." +
          "Only works within allowed directories.",
        inputSchema: zodToJsonSchema(WriteFileArgsSchema) as ToolInput,
      },
      {
        name: "str_replace",
        description:
          "Replace text in a file using string matching. Finds exact text and replaces it. " +
          "This is a simplified version of str_replace_editor. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(StrReplaceArgsSchema) as ToolInput,
      },
      {
        name: "insert",
        description:
          "Insert text at a specific line in a file. Line numbers are 0-indexed, " +
          "use 0 to insert at the beginning of the file. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(InsertArgsSchema) as ToolInput,
      },
      {
        name: "remove",
        description:
          "Remove (delete) a file. Remove deprecated code so keep code base simple. " +
          "Don't worry about this not working with undo as we are working in git and recovering " +
          "is easy. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(RemoveFileArgsSchema) as ToolInput,
      },
      {
        name: "move",
        description:
          "Move or rename files and directories. Can move files between directories " +
          "and rename them in a single operation. If the destination exists, the " +
          "operation will fail. Works across different directories and can be used " +
          "for simple renaming within the same directory. Both source and destination must be within allowed directories.",
        inputSchema: zodToJsonSchema(MoveFileArgsSchema) as ToolInput,
      },
      // Continue with original tools
      {
        name: "create_directory",
        description:
          "Create a new directory or ensure a directory exists. Can create multiple " +
          "nested directories in one operation. If the directory already exists, " +
          "this operation will succeed silently. Perfect for setting up directory " +
          "structures for projects or ensuring required paths exist. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(CreateDirectoryArgsSchema) as ToolInput,
      },
      {
        name: "list_directory",
        description:
          "Get a detailed listing of all files and directories in a specified path. " +
          "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
          "prefixes. This tool is essential for understanding directory structure and " +
          "finding specific files within a directory. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ListDirectoryArgsSchema) as ToolInput,
      },
      {
        name: "directory_tree",
        description:
            "Get a recursive tree view of files and directories as a JSON structure. " +
            "Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
            "Files have no children array, while directories always have a children array (which may be empty). " +
            "The output is formatted with 2-space indentation for readability. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(DirectoryTreeArgsSchema) as ToolInput,
      },
      {
        name: "search_files",
        description:
          "Recursively search for files and directories matching a pattern. " +
          "Searches through all subdirectories from the starting path. The search " +
          "is case-insensitive and matches partial names. Returns full paths to all " +
          "matching items. Great for finding files when you don't know their exact location. " +
          "Only searches within allowed directories.",
        inputSchema: zodToJsonSchema(SearchFilesArgsSchema) as ToolInput,
      },
      {
        name: "get_file_info",
        description:
          "Retrieve detailed metadata about a file or directory. Returns comprehensive " +
          "information including size, creation time, last modified time, permissions, " +
          "and type. This tool is perfect for understanding file characteristics " +
          "without reading the actual content. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(GetFileInfoArgsSchema) as ToolInput,
      },
      {
        name: "search_text",
        description:
          "VS-Code-style content search (regex | matchCase | wholeWord) with include/exclude globs. " +
          "Returns one line per match: path:line:preview. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(TextSearchArgsSchema) as ToolInput,
      },
    ],
  };
});


server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "str_replace_editor": {
        // Handle command-based operations
        const parsed = CommandArgsSchema.safeParse(args);
        if (!parsed.success) {
          // Try parsing as simple str_replace
          const strReplaceParsed = StrReplaceArgsSchema.safeParse(args);
          if (!strReplaceParsed.success) {
            throw new Error(`Invalid arguments for str_replace_editor: ${parsed.error}`);
          }
          // Convert to command format
          const validPath = await validatePath(strReplaceParsed.data.path);
          const edits = [{
            oldText: strReplaceParsed.data.old_str,
            newText: strReplaceParsed.data.new_str
          }];
          const result = await applyFileEdits(validPath, edits, false);
          return {
            content: [{ type: "text", text: result }],
          };
        }
        
        const validPath = await validatePath(parsed.data.path);
        
        switch (parsed.data.command) {
          case "str_replace": {
            if (!parsed.data.old_str || !parsed.data.new_str) {
              throw new Error("str_replace command requires old_str and new_str");
            }
            const edits = [{
              oldText: parsed.data.old_str,
              newText: parsed.data.new_str
            }];
            const result = await applyFileEdits(validPath, edits, false);
            return {
              content: [{ type: "text", text: result }],
            };
          }
          
          case "insert": {
            if (parsed.data.insert_line === undefined || !parsed.data.new_str) {
              throw new Error("insert command requires insert_line and new_str");
            }
            const result = await insertAtLine(validPath, parsed.data.insert_line, parsed.data.new_str);
            return {
              content: [{ type: "text", text: result }],
            };
          }
          
          case "undo_edit": {
            const history = editHistory.get(validPath);
            if (!history || history.length === 0) {
              throw new Error(`No edit history available for ${parsed.data.path}`);
            }
            const previousContent = history.pop();
            editHistory.set(validPath, history);
            
            const currentContent = await fs.readFile(validPath, 'utf-8');
            await fs.writeFile(validPath, previousContent!, 'utf-8');
            
            const diff = createUnifiedDiff(currentContent, previousContent!, validPath);
            let numBackticks = 3;
            while (diff.includes('`'.repeat(numBackticks))) {
              numBackticks++;
            }
            const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\nReverted to previous version.`;
            
            return {
              content: [{ type: "text", text: formattedDiff }],
            };
          }
          
          default:
            throw new Error(`Unknown command: ${parsed.data.command}`);
        }
      }

      case "str_replace_based_edit_tool":
      case "str_replace": {
        const parsed = StrReplaceArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for ${name}: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        // Convert to edit_file format
        const edits = [{
          oldText: parsed.data.old_str,
          newText: parsed.data.new_str
        }];
        const result = await applyFileEdits(validPath, edits, false);
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "insert": {
        const parsed = InsertArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for insert: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const result = await insertAtLine(validPath, parsed.data.insert_line, parsed.data.new_str);
        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "view": {
        const parsed = ViewArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for view: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        
        // Check if it's a directory
        const stats = await fs.stat(validPath);
        if (stats.isDirectory()) {
          // List directory contents
          const entries = await fs.readdir(validPath, { withFileTypes: true });
          const formatted = entries
            .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
            .join("\n");
          return {
            content: [{ type: "text", text: formatted }],
          };
        } else {
          // Read file
          const content = await fs.readFile(validPath, "utf-8");
          
          // Handle view_range if provided
          if (parsed.data.view_range && parsed.data.view_range.length === 2) {
            const lines = content.split('\n');
            const [start, end] = parsed.data.view_range;
            // Convert to 0-indexed and handle -1 for end
            const startIdx = Math.max(0, start - 1);
            const endIdx = end === -1 ? lines.length : Math.min(lines.length, end);
            const selectedLines = lines.slice(startIdx, endIdx);
            return {
              content: [{ type: "text", text: selectedLines.join('\n') }],
            };
          }
          
          return {
            content: [{ type: "text", text: content }],
          };
        }
      }

      case "create": {
        const parsed = WriteFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for create: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        await fs.writeFile(validPath, parsed.data.content, "utf-8");
        return {
          content: [{ type: "text", text: `Successfully created ${parsed.data.path}` }],
        };
      }

      case "move":
      case "move_file": {
        const parsed = MoveFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for ${name}: ${parsed.error}`);
        }
        const validSourcePath = await validatePath(parsed.data.source);
        const validDestPath = await validatePath(parsed.data.destination);
        await fs.rename(validSourcePath, validDestPath);
        return {
          content: [{ type: "text", text: `Successfully moved ${parsed.data.source} to ${parsed.data.destination}` }],
        };
      }

      case "remove": {
        const parsed = RemoveFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for remove: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        
        // Check if it's a directory
        const stats = await fs.stat(validPath);
        if (stats.isDirectory()) {
          await fs.rmdir(validPath, { recursive: true });
          return {
            content: [{ type: "text", text: `Successfully removed directory ${parsed.data.path}` }],
          };
        } else {
          await fs.unlink(validPath);
          return {
            content: [{ type: "text", text: `Successfully removed file ${parsed.data.path}` }],
          };
        }
      }

      case "create_directory": {
        const parsed = CreateDirectoryArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for create_directory: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        await fs.mkdir(validPath, { recursive: true });
        return {
          content: [{ type: "text", text: `Successfully created directory ${parsed.data.path}` }],
        };
      }

      case "list_directory": {
        const parsed = ListDirectoryArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for list_directory: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const entries = await fs.readdir(validPath, { withFileTypes: true });
        const formatted = entries
          .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
          .join("\n");
        return {
          content: [{ type: "text", text: formatted }],
        };
      }

      case "directory_tree": {
        const parsed = DirectoryTreeArgsSchema.safeParse(args);
        if (!parsed.success) {
            throw new Error(`Invalid arguments for directory_tree: ${parsed.error}`);
        }

        interface TreeEntry {
            name: string;
            type: 'file' | 'directory';
            children?: TreeEntry[];
        }

        async function buildTree(currentPath: string): Promise<TreeEntry[]> {
            const validPath = await validatePath(currentPath);
            const entries = await fs.readdir(validPath, {withFileTypes: true});
            const result: TreeEntry[] = [];

            for (const entry of entries) {
                const entryData: TreeEntry = {
                    name: entry.name,
                    type: entry.isDirectory() ? 'directory' : 'file'
                };

                if (entry.isDirectory()) {
                    const subPath = path.join(currentPath, entry.name);
                    entryData.children = await buildTree(subPath);
                }

                result.push(entryData);
            }

            return result;
        }

        const treeData = await buildTree(parsed.data.path);
        return {
            content: [{
                type: "text",
                text: JSON.stringify(treeData, null, 2)
            }],
        };
      }

      case "search_files": {
        const parsed = SearchFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for search_files: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const results = await searchFiles(validPath, parsed.data.pattern, parsed.data.excludePatterns);
        return {
          content: [{ type: "text", text: results.length > 0 ? results.join("\n") : "No matches found" }],
        };
      }

      case "get_file_info": {
        const parsed = GetFileInfoArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for get_file_info: ${parsed.error}`);
        }
        const validPath = await validatePath(parsed.data.path);
        const info = await getFileStats(validPath);
        return {
          content: [{ type: "text", text: Object.entries(info)
            .map(([key, value]) => `${key}: ${value}`)
            .join("\n") }],
        };
      }

      case "search_text": {
        const parsed = TextSearchArgsSchema.safeParse(args);
        if (!parsed.success) throw new Error(parsed.error.message);

        const validPath = await validatePath(parsed.data.path);
        const stats = await fs.stat(validPath);
        
        let root: string;
        let target: string;
        
        if (stats.isFile()) {
          // If it's a file, search only that file
          root = path.dirname(validPath);
          target = path.basename(validPath);
        } else {
          // If it's a directory, search the entire directory
          root = validPath;
          target = '.';
        }
        
        const results = await runRipgrep({
          root,
          query: parsed.data.search,
          isRegex: parsed.data.isRegex,
          matchCase: parsed.data.matchCase,
          wholeWord: parsed.data.wholeWord,
          includes: parsed.data.includePatterns,
          excludes: parsed.data.excludePatterns,
          target,
        });

        return {
          content: [{
            type: "text",
            text: results.length ? results.join('\n') : 'No matches found',
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Text Editor Server running on stdio");
  console.error("Allowed directories:", allowedDirectories);
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});