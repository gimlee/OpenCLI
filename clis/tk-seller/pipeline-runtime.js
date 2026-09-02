import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CommandExecutionError } from '@jackwener/opencli/errors';

const DEFAULT_START_TIMEOUT_MS = 30_000;

function isLoopbackPipelineUrl(baseUrl) {
    try {
        const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
        return ['127.0.0.1', 'localhost', '::1'].includes(hostname);
    }
    catch {
        return false;
    }
}

function pipelineProjectCandidates(explicitProjectDir) {
    const adapterDirectory = dirname(fileURLToPath(import.meta.url));
    return [...new Set([
        explicitProjectDir,
        process.env.PIM_PROJECT_DIR,
        resolve(adapterDirectory, '..', '..', '..', 'product-info-management'),
        resolve(process.cwd(), 'product-info-management'),
        resolve(process.cwd(), '..', 'product-info-management'),
        process.cwd(),
    ].filter(Boolean).map((value) => resolve(String(value))))];
}

function findPipelineProject(explicitProjectDir) {
    return pipelineProjectCandidates(explicitProjectDir).find((directory) => (
        existsSync(resolve(directory, 'app', 'main.py'))
        && (
            existsSync(resolve(directory, 'pyproject.toml'))
            || existsSync(resolve(directory, 'requirements.txt'))
        )
    ));
}

async function pipelineHealth(baseUrl) {
    try {
        const response = await fetch(new URL('/health', `${baseUrl}/`), {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(1500),
        });
        return response.ok;
    }
    catch {
        return false;
    }
}

function spawnPipeline(projectDir, baseUrl) {
    const url = new URL(baseUrl);
    const host = url.hostname.replace(/^\[|\]$/g, '') || '127.0.0.1';
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const windowsPython = resolve(projectDir, '.venv', 'Scripts', 'python.exe');
    const unixPython = resolve(projectDir, '.venv', 'bin', 'python');
    const executable = existsSync(windowsPython)
        ? windowsPython
        : existsSync(unixPython) ? unixPython : 'uv';
    const args = executable === 'uv'
        ? ['run', 'uvicorn', 'app.main:app', '--host', host, '--port', String(port)]
        : ['-m', 'uvicorn', 'app.main:app', '--host', host, '--port', String(port)];

    return spawn(executable, args, {
        cwd: projectDir,
        env: process.env,
        stdio: 'ignore',
        windowsHide: true,
    });
}

async function stopOwnedPipeline(child) {
    if (!child || child.exitCode !== null || child.killed) return;
    const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
    child.kill();
    await Promise.race([
        exited,
        new Promise((resolveWait) => setTimeout(resolveWait, 3000)),
    ]);
}

async function ensureLocalPipeline(options) {
    const {
        baseUrl,
        autoStart = true,
        projectDir,
        startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
        healthCheck = pipelineHealth,
        resolveProjectDir = findPipelineProject,
        startProcess = spawnPipeline,
        sleep = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
    } = options;

    if (await healthCheck(baseUrl)) {
        return { started: false, projectDir: null, stop: async () => {} };
    }
    if (!autoStart || !isLoopbackPipelineUrl(baseUrl)) {
        throw new CommandExecutionError(
            `Cannot reach the local product pipeline at ${baseUrl}`,
            autoStart
                ? 'Automatic startup is limited to localhost URLs.'
                : 'Enable --auto-start-pipeline true or start the pipeline manually.',
        );
    }

    const resolvedProjectDir = resolveProjectDir(projectDir);
    if (!resolvedProjectDir) {
        throw new CommandExecutionError(
            `Cannot reach the local product pipeline at ${baseUrl}`,
            'Set --pim-project-dir or PIM_PROJECT_DIR to the product-info-management directory.',
        );
    }

    const child = startProcess(resolvedProjectDir, baseUrl);
    let exitCode = null;
    child.once('exit', (code) => { exitCode = code; });
    const deadline = Date.now() + Math.max(1000, Number(startTimeoutMs) || DEFAULT_START_TIMEOUT_MS);

    while (Date.now() < deadline) {
        if (exitCode !== null) {
            throw new CommandExecutionError(
                `Local product pipeline exited during startup (code ${exitCode})`,
                `Check the Python environment in ${resolvedProjectDir}.`,
            );
        }
        if (await healthCheck(baseUrl)) {
            return {
                started: true,
                projectDir: resolvedProjectDir,
                stop: async () => await stopOwnedPipeline(child),
            };
        }
        await sleep(250);
    }

    await stopOwnedPipeline(child);
    throw new CommandExecutionError(
        `Local product pipeline did not become ready at ${baseUrl}`,
        `Check the Python environment in ${resolvedProjectDir}.`,
    );
}

export {
    ensureLocalPipeline,
    findPipelineProject,
    isLoopbackPipelineUrl,
    pipelineHealth,
    pipelineProjectCandidates,
    stopOwnedPipeline,
};
