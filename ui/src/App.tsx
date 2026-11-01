import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type Environments,
  type RunSummary,
  type TreeNode,
  type ValidationError,
} from './api.ts';
import { Editor } from './Editor.tsx';
import { FileTree } from './FileTree.tsx';
import { applyRunEvent, fromRecord, type RunView } from './run.ts';
import { RunPanel } from './RunPanel.tsx';

type OpenFile = { path: string; savedContent: string };

const isScenario = (path: string) =>
  /\.ya?ml$/.test(path) && !/(^|\/)n8nt\.config\.ya?ml$/.test(path);

export function App() {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [environments, setEnvironments] = useState<Environments>();
  const [environment, setEnvironment] = useState('');
  const [file, setFile] = useState<OpenFile>();
  const [content, setContent] = useState('');
  const [problems, setProblems] = useState<ValidationError[]>([]);
  const [notice, setNotice] = useState('');
  // Set after the server refused an invalid file, to offer "Save anyway".
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState('');
  const [run, setRun] = useState<RunView>();
  const [history, setHistory] = useState<RunSummary[]>([]);

  const isDirty = file !== undefined && content !== file.savedContent;
  const isRunning = run?.status === 'running';

  useEffect(() => {
    Promise.all([api.tree(), api.environments(), api.runs()])
      .then(([tree, environments, history]) => {
        setTree(tree);
        setEnvironments(environments);
        setEnvironment(environments.defaultEnvironment);
        setHistory(history);
      })
      .catch((error: Error) => setError(error.message));
  }, []);

  useEffect(() => {
    if (!isDirty) {
      return;
    }

    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [isDirty]);

  async function openFile(path: string) {
    if (path === file?.path || (isDirty && !confirm('Discard unsaved changes?'))) {
      return;
    }

    try {
      const loaded = await api.readFile(path);
      setFile({ path, savedContent: loaded.content });
      setContent(loaded.content);
      setProblems(loaded.validation.valid ? [] : loaded.validation.errors);
      setNotice('');
      setRefused(false);
      setError('');
    } catch (error) {
      setError((error as Error).message);
    }
  }

  // Returns whether the file is now saved.
  async function save(force = false) {
    if (!file) {
      return false;
    }

    try {
      await api.saveFile(file.path, content, force);
      setFile({ ...file, savedContent: content });
      setNotice('Saved.');
      setRefused(false);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) {
        setProblems(error.body.validation.errors);
        setNotice('Not saved: the file has problems.');
        setRefused(true);
      } else {
        setNotice(`Not saved: ${(error as Error).message}`);
      }
      return false;
    }
  }

  async function startRun(paths: string[]) {
    // The server runs what is on disk, so run what the editor shows.
    if (isDirty && !(await save())) {
      return;
    }

    setRun({ status: 'running', scenarios: [] });

    try {
      await api.startRun(paths, environment, (event) =>
        setRun((current) => applyRunEvent(current!, event)),
      );
      setRun((current) =>
        current!.status === 'running'
          ? { ...current!, status: 'error', error: 'The server closed the run before it finished.' }
          : current,
      );
      setHistory(await api.runs());
    } catch (error) {
      setRun({ status: 'error', error: (error as Error).message, scenarios: [] });
    }
  }

  async function openRun(id: string) {
    try {
      setRun(fromRecord(await api.run(id)));
    } catch (error) {
      setError((error as Error).message);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <strong>n8nt</strong>
        {environments && (
          <label className="environment">
            Environment
            <select value={environment} onChange={(event) => setEnvironment(event.target.value)}>
              {environments.environments.map((env) => (
                <option key={env.name} value={env.name} title={env.baseUrl}>
                  {env.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {error && <div className="banner">{error}</div>}

      <aside className="sidebar">
        <button className="run-all" onClick={() => startRun(['.'])} disabled={isRunning}>
          ▶ Run all
        </button>
        <FileTree nodes={tree} selected={file?.path} onSelect={openFile} />
      </aside>

      <main className="main">
        {file ? (
          <>
            <div className="toolbar">
              <span className="path">
                {file.path}
                {isDirty && <span title="Unsaved changes"> ●</span>}
              </span>
              <span className="notice">{notice}</span>
              {refused && <button onClick={() => save(true)}>Save anyway</button>}
              <button onClick={() => save()} disabled={!isDirty}>
                Save
              </button>
              {isScenario(file.path) && (
                <button onClick={() => startRun([file.path])} disabled={isRunning}>
                  ▶ Run
                </button>
              )}
            </div>
            <Editor
              key={file.path}
              path={file.path}
              content={file.savedContent}
              onChange={(text) => {
                setContent(text);
                setNotice('');
                setRefused(false);
              }}
              onSave={() => save()}
              onValidation={setProblems}
            />
            <section className="problems" aria-label="Problems">
              {problems.length === 0 ? (
                <p className="muted">No problems.</p>
              ) : (
                <ul>
                  {problems.map((problem, index) => (
                    <li key={index}>{problem.message}</li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : (
          <p className="muted empty">Pick a file on the left.</p>
        )}
      </main>

      <RunPanel view={run} history={history} onOpenRun={openRun} />
    </div>
  );
}
