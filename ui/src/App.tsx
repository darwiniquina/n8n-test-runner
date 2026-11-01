import { useEffect, useState } from 'react';
import { api, ApiError, type Environments, type TreeNode, type ValidationError } from './api.ts';
import { Editor } from './Editor.tsx';
import { FileTree } from './FileTree.tsx';

type OpenFile = { path: string; savedContent: string };

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

  const isDirty = file !== undefined && content !== file.savedContent;

  useEffect(() => {
    Promise.all([api.tree(), api.environments()])
      .then(([tree, environments]) => {
        setTree(tree);
        setEnvironments(environments);
        setEnvironment(environments.defaultEnvironment);
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

  async function save(force = false) {
    if (!file) {
      return;
    }

    try {
      await api.saveFile(file.path, content, force);
      setFile({ ...file, savedContent: content });
      setNotice('Saved.');
      setRefused(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) {
        setProblems(error.body.validation.errors);
        setNotice('Not saved: the file has problems.');
        setRefused(true);
      } else {
        setNotice(`Not saved: ${(error as Error).message}`);
      }
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
    </div>
  );
}
