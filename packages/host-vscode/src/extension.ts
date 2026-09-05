/**
 * `activate`/`deactivate` (P3 W10, §2.1). Builds the concrete ports P3 actually has a VS Code
 * consumer for (§4.2's "Which ports P3 implements" table) and wires them into one `RepoService`
 * shared by every resolve of the panel webview.
 *
 * `Storage` is deliberately not constructed here even though `docs/plans/P3.md`'s W10 lists it
 * among activate()'s ports: `ports/storage.ts` is written and ready, but VS Code has no caller
 * for it yet (§9's "present but not exercised" is the thing to avoid, not a port's own
 * existence — whichever phase gives VS Code its first recent-repos/window-bounds consumer
 * constructs it there).
 */
import { coerceSettings, SETTINGS, type SettingKey, type Settings } from "@kira-version/core";
import {
  createVirtualDocumentSource,
  NodeFileWatcher,
  NodeProcessRunner,
  RepoService,
} from "@kira-version/git";
import type { SettingsSnapshot } from "@kira-version/ipc";
import * as vscode from "vscode";
import { KiraGraphViewProvider } from "./panelView.ts";
import { VsCodeClipboard } from "./ports/clipboard.ts";
import { VsCodeDialogs } from "./ports/dialogs.ts";
import { VsCodeEditorIntegration } from "./ports/editorIntegration.ts";
import { VsCodeLogger } from "./ports/logger.ts";
import { VsCodeTheme } from "./ports/theme.ts";
import { VsCodeWorkspaceRoots } from "./ports/workspaceRoots.ts";

const VIEW_ID = "kiraVersion.graph";
const FOCUS_COMMAND = "kiraVersion.focusGraph";
const SETTING_KEYS = Object.keys(SETTINGS) as readonly SettingKey[];

function readRawSettings(config: vscode.WorkspaceConfiguration): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const value = config.get(key);
    if (value !== undefined) raw[key] = value;
  }
  return raw;
}

/** A structural copy of `@kira-version/git/rpcHandlers.ts`'s own private helper of the same
 *  name — `settings.changed`'s payload is `app.init`'s wire shape, but pushed by `extension.ts`
 *  itself rather than answered from a request, so it needs the same conversion here. */
function toSettingsSnapshot(settings: Settings): SettingsSnapshot {
  return {
    "kiraVersion.git.path": settings["kiraVersion.git.path"],
    "kiraVersion.graph.pageSize": settings["kiraVersion.graph.pageSize"],
    "kiraVersion.graph.scope": settings["kiraVersion.graph.scope"],
    "kiraVersion.log.level": settings["kiraVersion.log.level"],
  };
}

/** §4.2 steps 1-2: the extension's own setting first, then VS Code's built-in `git.path`,
 *  filtered for empties — the parameter P1 built and left empty until now. */
function configuredGitCandidates(settings: Settings): readonly string[] {
  const builtInGitPath = vscode.workspace.getConfiguration("git").get<string>("path");
  return [settings["kiraVersion.git.path"], builtInGitPath ?? ""].filter((path) => path.length > 0);
}

let service: RepoService | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("Kira Version");
  context.subscriptions.push(outputChannel);

  let currentSettings = coerceSettings(
    readRawSettings(vscode.workspace.getConfiguration()),
  ).settings;
  const logger = new VsCodeLogger(outputChannel, () => currentSettings["kiraVersion.log.level"]);
  const roots = new VsCodeWorkspaceRoots();
  const dialogs = new VsCodeDialogs();
  const theme = new VsCodeTheme();
  const editor = new VsCodeEditorIntegration();
  const clipboard = new VsCodeClipboard();

  const repoService = await RepoService.create({
    runner: new NodeProcessRunner(),
    fileWatcher: new NodeFileWatcher(logger.child("fileWatcher")),
    logger,
    settings: currentSettings,
    configuredGitCandidates: configuredGitCandidates(currentSettings),
  });
  service = repoService;
  logger.log("info", "activated", { git: repoService.git, theme: theme.current() });

  // Registered once, here, rather than inside `createRepoHandlers`: `resolveWebviewView` reruns
  // on every hide/reveal, and VS Code allows only one content provider per scheme.
  context.subscriptions.push(
    editor.registerVirtualDocuments(createVirtualDocumentSource(repoService)),
  );

  const provider = new KiraGraphViewProvider({
    extensionUri: context.extensionUri,
    service: repoService,
    roots,
    dialogs,
    settings: () => currentSettings,
    logger,
    editor,
    clipboard,
  });

  context.subscriptions.push(
    vscode.commands.registerCommand(FOCUS_COMMAND, () =>
      vscode.commands.executeCommand(`${VIEW_ID}.focus`),
    ),
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("kiraVersion") && !event.affectsConfiguration("git.path"))
        return;
      const { settings, problems } = coerceSettings(
        readRawSettings(vscode.workspace.getConfiguration()),
      );
      currentSettings = settings;
      for (const problem of problems) {
        logger.log("warn", "invalid setting, using default", problem);
      }
      provider.notifySettingsChanged(toSettingsSnapshot(currentSettings));
    }),
  );
}

export function deactivate(): void {
  service?.dispose();
  service = undefined;
}
