import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

async function main(entry: string) {
  const result = executeOperationSync(() =>
    require.resolve(path.resolve(process.cwd(), entry)),
  );

  if (!result.success) {
    console.error(`Was not able to resolve ${entry}`);

    process.exit(1);
  }

  console.log(`Watching: ${entry}`);

  watch(result.data);
}

main(process.argv[2]);

const moduleStatusMap = new Map<
  string,
  { key: string; timestamp: number; lastReloadedCycle: number }
>();

const DELAY = 500;

async function watch(filePath: string) {
  while (true) {
    await processModuleUpdates(filePath).catch(console.error);
    await new Promise((resolve) => setTimeout(resolve, DELAY));
  }
}

async function resolveModuleDependencies(
  entryPath: string | null,
  dependencyPairsList: { key: string; parent: string }[] = [],
  importerPath: string = "",
  visitedInThisTraversal: Set<string> = new Set(),
): Promise<{ key: string; parent: string }[]> {
  if (!entryPath || visitedInThisTraversal.has(entryPath))
    return dependencyPairsList;

  visitedInThisTraversal.add(entryPath);
  dependencyPairsList.push({ key: entryPath, parent: importerPath });

  const readFileResult = await executeOperation(() =>
    fs.readFile(entryPath, "utf8"),
  );
  if (!readFileResult.success) return dependencyPairsList;

  const resolvedImportPaths = await findImportPaths(
    readFileResult.data,
    entryPath,
  );

  await Promise.all(
    resolvedImportPaths.map((dependencyPath) =>
      resolveModuleDependencies(
        dependencyPath,
        dependencyPairsList,
        entryPath,
        visitedInThisTraversal,
      ),
    ),
  );

  return dependencyPairsList;
}

async function findImportPaths(fileContent: string, entryPath: string) {
  const resolvedImportPaths: string[] = [];

  if (!fileContent) return resolvedImportPaths;

  const parseResult = executeOperationSync(() =>
    parse(fileContent, {
      sourceType: "module",
      plugins: ["typescript"],
    }),
  );

  if (!parseResult.success) {
    return resolvedImportPaths;
  }

  const containingDir = path.dirname(entryPath);

  const addResolveImportPath = (value: string) => {
    const requireResolveResult = executeOperationSync(() =>
      require.resolve(path.resolve(containingDir, value)),
    );

    if (requireResolveResult.success) {
      resolvedImportPaths.push(requireResolveResult.data);
    }
  };

  traverse(parseResult.data, {
    CallExpression({ node }) {
      const isImportExpression =
        node.callee && node.callee && node.callee.type === "Import";
      const importArgument = node.arguments[0];
      const isStringLiteral = importArgument?.type === "StringLiteral";

      if (!isImportExpression) return;
      if (!isStringLiteral) return;

      addResolveImportPath(importArgument.value);
    },
    ImportDeclaration({ node }) {
      addResolveImportPath(node.source.value);
    },
  });

  return resolvedImportPaths;
}

let currentCycle = 0;

async function processModuleUpdates(resolvedEntryPath: string) {
  const dependencyPairsList =
    await resolveModuleDependencies(resolvedEntryPath);
  const allModulePaths = Array.from(
    new Set(dependencyPairsList.map((depPair) => depPair.key)),
  );

  const importerMap = Object.fromEntries(
    dependencyPairsList.map((depPair) => [depPair.key, depPair.parent]),
  );

  pruneStaleModules(allModulePaths);

  const statResults = await Promise.allSettled(
    allModulePaths.map((modulePath) =>
      executeOperation(() => fs.stat(modulePath)),
    ),
  );

  const changedModulePaths = allModulePaths.filter((modulePath, index) => {
    const statResult = statResults[index];
    if (statResult.status !== "fulfilled" || !statResult.value.success)
      return false;

    const currentTimestamp = statResult.value.data.mtimeMs;
    const currentStatus = moduleStatusMap.get(modulePath);

    if (currentStatus && currentTimestamp === currentStatus.timestamp)
      return false;

    moduleStatusMap.set(modulePath, {
      key: modulePath,
      timestamp: currentTimestamp,
      lastReloadedCycle: currentStatus?.lastReloadedCycle ?? -1,
    });

    return true;
  });

  if (!changedModulePaths.length) return;

  currentCycle = (currentCycle + 1) % Number.MAX_SAFE_INTEGER;

  for (const changedPath of changedModulePaths.toReversed()) {
    const modulesToReload: string[] = [];
    let moduleToReloadPath: string | undefined = changedPath;

    while (moduleToReloadPath) {
      modulesToReload.push(moduleToReloadPath);
      moduleToReloadPath = importerMap[moduleToReloadPath];
    }

    for (const modulePath of modulesToReload) {
      reloadModule(modulePath);
    }
  }
}

function reloadModule(path: string) {
  const moduleStatus = moduleStatusMap.get(path);
  assert(moduleStatus, "Path should exist in the module status map");

  if (moduleStatus.lastReloadedCycle >= currentCycle) return;

  delete require.cache[path];
  require(path);
  moduleStatusMap.set(path, {
    ...moduleStatus,
    lastReloadedCycle: currentCycle,
  });
}

function pruneStaleModules(activeModulePaths: string[]) {
  if (!moduleStatusMap.size) return;

  const activePathsSet = new Set(activeModulePaths);

  if (activePathsSet.size === moduleStatusMap.size) {
    return;
  }

  for (const trackedPath of moduleStatusMap.keys()) {
    if (!activePathsSet.has(trackedPath)) {
      moduleStatusMap.delete(trackedPath);
      delete require.cache[trackedPath];
    }
  }
}

type Result<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      error: unknown;
    };

async function executeOperation<T>(
  operation: () => Promise<T>,
): Promise<Result<T>> {
  try {
    const result = await operation();
    return {
      success: true,
      data: result,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function executeOperationSync<T>(operation: () => T): Result<T> {
  try {
    const result = operation();
    return {
      success: true,
      data: result,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
