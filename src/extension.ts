'use strict';

// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// Standard node imports
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// External dependencies
import * as yaml from 'js-yaml';
import * as dockerfileParse from 'dockerfile-parse';
import * as tmp from 'tmp';

// Internal dependencies
import * as explainer from './explainer';
import * as shell from './shell';
import * as acs from './acs';
import * as kuberesources from './kuberesources';
import * as docker from './docker';
import * as kubeconfig from './kubeconfig';

const WINDOWS = 'win32';

let explainActive = false;
let kubectlFound = false;
let swaggerSpecPromise = null;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context) {
    checkForKubectl('activation', () => {});

    const subscriptions = [
        vscode.commands.registerCommand('extension.vsKubernetesCreate',
            maybeRunKubernetesCommandForActiveWindow.bind(this, 'create -f')
        ),
        vscode.commands.registerCommand('extension.vsKubernetesDelete', deleteKubernetes),
        vscode.commands.registerCommand('extension.vsKubernetesApply', applyKubernetes),
        vscode.commands.registerCommand('extension.vsKubernetesExplain', explainActiveWindow),
        vscode.commands.registerCommand('extension.vsKubernetesLoad', loadKubernetes),
        vscode.commands.registerCommand('extension.vsKubernetesGet', getKubernetes),
        vscode.commands.registerCommand('extension.vsKubernetesRun', runKubernetes),
        vscode.commands.registerCommand('extension.vsKubernetesLogs', logsKubernetes),
        vscode.commands.registerCommand('extension.vsKubernetesExpose', exposeKubernetes),
        vscode.commands.registerCommand('extension.vsKubernetesDescribe', describeKubernetes),
        vscode.commands.registerCommand('extension.vsKubernetesSync', syncKubernetes),
        vscode.commands.registerCommand('extension.vsKubernetesExec', execKubernetes),
        vscode.commands.registerCommand('extension.vsKubernetesTerminal', terminalKubernetes),
        vscode.commands.registerCommand('extension.vsKubernetesDiff', diffKubernetes),
        vscode.commands.registerCommand('extension.vsKubernetesScale', scaleKubernetes),
        vscode.commands.registerCommand('extension.vsKubernetesDebug', debugKubernetes),
        vscode.commands.registerCommand('extension.vsKubernetesRemoveDebug', removeDebugKubernetes),
        vscode.commands.registerCommand('extension.vsKubernetesConfigureFromAcs', configureFromAcsKubernetes),
        vscode.languages.registerHoverProvider(
            { language: 'json', scheme: 'file' },
            { provideHover: provideHoverJson }
        ),
        vscode.languages.registerHoverProvider(
            { language: 'yaml', scheme: 'file' },
            { provideHover: provideHoverYaml }
        )
    ];

    subscriptions.forEach((element) => {
        context.subscriptions.push(element);
    }, this);
}

// this method is called when your extension is deactivated
export const deactivate = () => { };

function checkForKubectl(errorMessageMode, handler?) {
    if (!kubectlFound) {
        checkForKubectlInternal(errorMessageMode, handler);
        return;
    }

    handler();
}

function checkForKubectlInternal(errorMessageMode, handler) {
    const
        contextMessage = getCheckKubectlContextMessage(errorMessageMode),
        bin = vscode.workspace.getConfiguration('vs-kubernetes')['vs-kubernetes.kubectl-path'];

    if (!bin) {
        findBinary('kubectl', (err, output) => {
            if (err || output.length === 0) {
                vscode.window.showErrorMessage('Could not find "kubectl" binary.' + contextMessage, 'Learn more').then(
                    (str) => {
                        if (str !== 'Learn more') {
                            return;
                        }

                        vscode.window.showInformationMessage('Add kubectl directory to path, or set "vs-kubernetes.kubectl-path" config to kubectl binary.');
                    }
                );

                return;
            }

            kubectlFound = true;

            if (handler) {
                handler();
            }
        });

        return;
    }

    kubectlFound = fs.existsSync(bin);
    if (!kubectlFound) {
        vscode.window.showErrorMessage(bin + ' does not exist!' + contextMessage);
        return;
    }

    handler();
}

function getCheckKubectlContextMessage(errorMessageMode) {
    if (errorMessageMode === 'activation') {
        return ' Kubernetes commands other than configuration will not function correctly.';
    } else if (errorMessageMode === 'command') {
        return ' Cannot execute command.';
    }
    return '';
}

function providerHover(document, position, token, syntax) {
    return new Promise(async (resolve) => {
        if (!explainActive) {
            resolve(null);
        }

        const body = document.getText();
        let obj: any = {};

        try {
            obj = syntax.parse(body);
        } catch (err) {
            // Bad document
            resolve(null);
        }

        // Not a k8s object.
        if (!obj.kind) {
            resolve(null);
        }

        let property = findProperty(document.lineAt(position.line)),
            field = syntax.parse(property),
            parentLine = syntax.findParent(document, position.line);

        while (parentLine !== -1) {
            let parentProperty = findProperty(document.lineAt(parentLine));
            field = syntax.parse(parentProperty) + '.' + field;
            parentLine = syntax.findParent(document, parentLine);
        }

        if (field === 'kind') {
            field = '';
        }

        explain(obj, field).then(
            (msg : string) => resolve(new vscode.Hover(msg))
        );
    });

}

function provideHoverJson(document, position, token) {
    const syntax = {
        parse: (text) => JSON.parse(text),
        findParent: (document, parentLine) => findParentJson(document, parentLine - 1)
    };

    return providerHover(document, position, token, syntax);
}

function provideHoverYaml(document, position, token) {
    const syntax = {
        parse: (text) => yaml.safeLoad(text),
        findParent: (document, parentLine) => findParentYaml(document, parentLine)
    };

    return providerHover(document, position, token, syntax);
}

function findProperty(line) {
    let ix = line.text.indexOf(':');
    return line.text.substring(line.firstNonWhitespaceCharacterIndex, ix);
}

function findParentJson(document, line) {
    let count = 1;
    while (line >= 0) {
        const txt = document.lineAt(line);
        if (txt.text.indexOf('}') !== -1) {
            count = count + 1;
        }
        if (txt.text.indexOf('{') !== -1) {
            count = count - 1;
            if (count === 0) {
                break;
            }
        }
        line = line - 1;
    }
    while (line >= 0) {
        const txt = document.lineAt(line);
        if (txt.text.indexOf(':') !== -1) {
            return line;
        }
        line = line - 1;
    }
    return line;
}

function findParentYaml(document, line) {
    let indent = yamlIndentLevel(document.lineAt(line).text)
    while (line >= 0) {
        let txt = document.lineAt(line);
        if (yamlIndentLevel(txt.text) < indent) {
            return line;
        }
        line = line - 1;
    }
    return line;
}

function yamlIndentLevel(str) {
    let i = 0;

    //eslint-disable-next-line no-constant-condition
    while (true) {
        if (str.length <= i || !isYamlIndentChar(str.charAt(i))) {
            return i;
        }
        ++i;
    }
}

function isYamlIndentChar(ch) {
    return ch === ' ' || ch === '-';
}

async function explain(obj, field) {
    return new Promise((resolve) => {
        if (!obj.kind) {
            vscode.window.showErrorMessage("Not a Kubernetes API Object!");
            resolve(null);
        }

        let ref = obj.kind;
        if (field && field.length > 0) {
            ref = ref + '.' + field;
        }

        if (!swaggerSpecPromise) {
            swaggerSpecPromise = explainer.readSwagger();
        }

        swaggerSpecPromise.then((s) => {
            resolve(explainer.readExplanation(s, ref));
        });
    });
}

function explainActiveWindow() {
    let editor = vscode.window.activeTextEditor;
    let bar = initStatusBar();

    if (!editor) {
        vscode.window.showErrorMessage('No active editor!');
        bar.hide();
        return; // No open text editor
    }

    explainActive = !explainActive;
    if (explainActive) {
        vscode.window.showInformationMessage('Kubernetes API explain activated.');
        bar.show();
        if (!swaggerSpecPromise) {
            swaggerSpecPromise = explainer.readSwagger();
        }
    } else {
        vscode.window.showInformationMessage('Kubernetes API explain deactivated.');
        bar.hide();
    }
}


let statusBarItem;

function initStatusBar() {
    if (!statusBarItem) {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        statusBarItem.text = 'kubernetes-api-explain';
    }

    return statusBarItem;
}

// Runs a command for the text in the active window.
// Expects that it can append a filename to 'command' to create a complete kubectl command.
//
// @parameter command string The command to run
function maybeRunKubernetesCommandForActiveWindow(command) {
    let text, proc;

    let editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor!');
        return false; // No open text editor
    }
    let namespace = vscode.workspace.getConfiguration('vs-kubernetes')['vs-kubernetes.namespace'];
    if (namespace) {
        command = command + '--namespace ' + namespace + ' ';
    }
    if (editor.selection) {
        text = editor.document.getText(editor.selection);
        if (text.length > 0) {
            kubectlViaTempFile(command, text);
            return true;
        }
    }
    if (editor.document.isUntitled) {
        text = editor.document.getText();
        if (text.length > 0) {
            kubectlViaTempFile(command, text);
            return true;
        }
        return false;
    }
    if (editor.document.isDirty) {
        // TODO: I18n this?
        const confirm = "Save";
        const promise = vscode.window.showWarningMessage("You have unsaved changes!", confirm);
        promise.then((value) => {
            if (value && value === confirm) {
                editor.document.save().then((ok) => {
                    if (!ok) {
                        vscode.window.showErrorMessage("Save failed.");
                        return;
                    }
                    kubectl(`${command} "${editor.document.fileName}"`);
                });
            }
        });
    } else {
        const fullCommand = `${command} "${editor.document.fileName}"`;
        console.log(fullCommand);
        kubectl(fullCommand);
    }
    return true;
}

function kubectlViaTempFile(command, fileContent) {
    const tmpobj = tmp.fileSync();
    fs.writeFileSync(tmpobj.name, fileContent);
    console.log(tmpobj.name);
    kubectl(`${command} ${tmpobj.name}`);
}

/**
 * Gets the text content (in the case of unsaved or selections), or the filename
 *
 * @param callback function(text, filename)
 */
function getTextForActiveWindow(callback) {
    let text;
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        vscode.window.showErrorMessage('No active editor!');
        callback(null, null);
        return;
    }

    if (editor.selection) {
        text = editor.document.getText(editor.selection);

        if (text.length === 0) {
            return;
        }

        callback(text, null)
        return;
    }

    if (editor.document.isUntitled) {
        text = editor.document.getText();

        if (text.length === 0) {
            return;
        }

        callback(text, null);
        return;
    }

    if (editor.document.isDirty) {
        // TODO: I18n this?
        let confirm = 'Save';
        let promise = vscode.window.showWarningMessage('You have unsaved changes!', confirm);
        promise.then((value) => {
            if (!value) {
                return;
            }

            if (value !== confirm) {
                return;
            }

            editor.document.save().then((ok) => {
                if (!ok) {
                    vscode.window.showErrorMessage('Save failed.');
                    callback(null, null);
                    return;
                }

                callback(null, editor.document.fileName);
            });

            return;
        });
    }

    callback(null, editor.document.fileName);
    return;
}

function loadKubernetes() {
    promptKindName(kuberesources.commonKinds, "load", { nameOptional: true }, (value) => {
        kubectlInternal(" -o json get " + value, (result, stdout, stderr) => {
            if (result !== 0) {
                vscode.window.showErrorMessage('Get command failed: ' + stderr);
                return;
            }

            const filename = value.replace('/', '-');
            const filepath = path.join(vscode.workspace.rootPath, filename + '.json');

            vscode.workspace.openTextDocument(vscode.Uri.parse('untitled:' + filepath)).then((doc) => {
                const start = new vscode.Position(0, 0),
                    end = new vscode.Position(0, 0),
                    range = new vscode.Range(start, end),
                    edit = new vscode.TextEdit(range, stdout),
                    wsEdit = new vscode.WorkspaceEdit();

                wsEdit.set(doc.uri, [edit]);
                vscode.workspace.applyEdit(wsEdit);
                vscode.window.showTextDocument(doc);
            });
        })
    });
}

function kubectlDone(result, stdout, stderr) {
    if (result !== 0) {
        vscode.window.showErrorMessage('Kubectl command failed: ' + stderr);
        console.log(stderr);
        return;
    }

    vscode.window.showInformationMessage(stdout);
}

function exposeKubernetes() {
    let kindName = findKindName();
    if (!kindName) {
        vscode.window.showErrorMessage('couldn\'t find a relevant type to expose.');
        return;
    }

    let cmd = `expose ${kindName}`;
    let ports = getPorts();

    if (ports && ports.length > 0) {
        cmd += ' --port=' + ports[0]
    }

    kubectl(cmd);
}

function kubectl(command) {
    kubectlInternal(command, kubectlDone);
}

function kubectlInternal(command, handler) {
    checkForKubectl('command', () => {
        const bin = baseKubectlPath();
        let cmd = bin + ' ' + command
        shell.exec(cmd, handler);
    });
}

function baseKubectlPath() {
    let bin = vscode.workspace.getConfiguration('vs-kubernetes')['vs-kubernetes.kubectl-path'];
    if (!bin) {
        bin = 'kubectl';
    }
    return bin;
}

function kubectlPath() {
    let bin = baseKubectlPath();
    if (process.platform == 'win32' && !(bin.endsWith('.exe'))) {
        bin = bin + '.exe';
    }
    return bin;
}

function getKubernetes() {
    let kindName = findKindName();
    if (kindName) {
        maybeRunKubernetesCommandForActiveWindow('get --no-headers -o wide -f ');
        return;
    }
    findKindNameOrPrompt(kuberesources.commonKinds, 'get', { nameOptional: true }, (value) => {
        kubectl(" get " + value + " -o wide --no-headers");
    });
}

function findVersion() {
    return {
        then: findVersionInternal
    }
};

function findVersionInternal(fn) {
    // No .git dir, use 'latest'
    // TODO: use 'git rev-parse' to detect upstream directories
    if (!fs.existsSync(path.join(vscode.workspace.rootPath, '.git'))) {
        fn('latest');
        return;
    }

    shell.execCore('git describe --always --dirty', shell.execOpts(), (code, stdout, stderr) => {
        if (code !== 0) {
            vscode.window.showErrorMessage('git log returned: ' + code);
            console.log(stderr);
            fn('error');
            return;
        }
        fn(stdout);
    });
}

function findPods(labelQuery, callback) {
    kubectlInternal(` get pods -o json -l ${labelQuery}`, (result, stdout, stderr) => {
        if (result !== 0) {
            vscode.window.showErrorMessage('Kubectl command failed: ' + stderr);
            return;
        }
        try {
            let podList = JSON.parse(stdout);
            callback(podList);
        } catch (ex) {
            console.log(ex);
            vscode.window.showErrorMessage('unexpected error: ' + ex);
        }
    });
}

function findPodsForApp(callback) {
    let appName = path.basename(vscode.workspace.rootPath);
    findPods(`run=${appName}`, callback);
}

function findDebugPodsForApp(callback) {
    let appName = path.basename(vscode.workspace.rootPath);
    findPods(`run=${appName}-debug`, callback);
}

function findNameAndImage() {
    return {
        then: _findNameAndImageInternal
    };
}

function _findNameAndImageInternal(fn) {
    if (vscode.workspace.rootPath === undefined) {
        vscode.window.showErrorMessage('This command requires an open folder.');
        return;
    }
    const folderName = path.basename(vscode.workspace.rootPath);
    const name = docker.sanitiseTag(folderName);
    findVersion().then((version) => {
        let image = name + ":" + version;
        let user = vscode.workspace.getConfiguration().get("vsdocker.imageUser", null);
        if (user) {
            image = user + '/' + image;
        }

        fn(name.trim(), image.trim());
    });
}

function scaleKubernetes() {
    findKindNameOrPrompt(kuberesources.scaleableKinds, 'scale', {}, (kindName) => {
        promptScaleKubernetes(kindName);
    });
}

function promptScaleKubernetes(kindName : string) {
    vscode.window.showInputBox({ prompt: `How many replicas would you like to scale ${kindName} to?` }).then((value) => {
        if (value) {
            let replicas = parseFloat(value);
            if (Number.isInteger(replicas) && replicas >= 0) {
                invokeScaleKubernetes(kindName, replicas);
            } else {
                vscode.window.showErrorMessage('Replica count must be a non-negative integer');
            }
        }
    });
}

function invokeScaleKubernetes(kindName : string, replicas : number) {
    kubectl(`scale --replicas=${replicas} ${kindName}`);
}

function runKubernetes() {
    buildPushThenExec((name, image) => {
        kubectlInternal(`run ${name} --image=${image}`, kubectlDone);
    });
}

function buildPushThenExec(fn) {
    findNameAndImage().then((name, image) => {
        shell.exec(`docker build -t ${image} .`, (result, stdout, stderr) => {
            if (result === 0) {
                vscode.window.showInformationMessage(image + ' built.');
                shell.exec('docker push ' + image, (result, stdout, stderr) => {
                    if (result === 0) {
                        vscode.window.showInformationMessage(image + ' pushed.');
                        fn(name, image);
                    } else {
                        vscode.window.showErrorMessage('Image push failed. See Output window for details.');
                        showOutput(stderr, 'Docker');
                        console.log(stderr);
                    }
                });
            } else {
                vscode.window.showErrorMessage('Image build failed. See Output window for details.');
                showOutput(stderr, 'Docker');
                console.log(stderr);
            }
        });
    });
}

function findKindName() {
    let editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor!');
        return null; // No open text editor
    }
    let text = editor.document.getText();
    return findKindNameForText(text);
}

function findKindNameForText(text) {
    try {
        let obj = yaml.safeLoad(text);
        if (!obj || !obj.kind) {
            return null;
        }
        if (!obj.metadata || !obj.metadata.name) {
            return null;
        }
        return obj.kind.toLowerCase() + '/' + obj.metadata.name;
    } catch (ex) {
        console.log(ex);
        return null;
    }
}

function findKindNameOrPrompt(resourceKinds : kuberesources.ResourceKind[], descriptionVerb, opts, handler) {
    let kindName = findKindName();
    if (kindName === null) {
        promptKindName(resourceKinds, descriptionVerb, opts, handler);
    } else {
        handler(kindName);
    }
}

function promptKindName(resourceKinds : kuberesources.ResourceKind[], descriptionVerb, opts, handler) {
    vscode.window.showInputBox({ prompt: "What resource do you want to " + descriptionVerb + "?", placeHolder: 'Empty string to be prompted' }).then((resource) => {
        if (resource === '') {
            quickPickKindName(resourceKinds, opts, handler);
        } else if (resource === undefined) {
            return;
        } else {
            handler(resource);
        }
    });
}

function quickPickKindName(resourceKinds : kuberesources.ResourceKind[], opts, handler) {
    vscode.window.showQuickPick(resourceKinds).then((resourceKind) => {
        if (resourceKind) {
            let kind = resourceKind.abbreviation;
            kubectlInternal("get " + kind, (code, stdout, stderr) => {
                if (code === 0) {
                    let names = parseNamesFromKubectlLines(stdout);
                    if (names.length > 0) {
                        if (opts && opts.nameOptional) {
                            names.push('(all)');
                            vscode.window.showQuickPick(names).then((name) => {
                                if (name) {
                                    let kindName;
                                    if (name === '(all)') {
                                        kindName = kind;
                                    } else {
                                        kindName = kind + '/' + name;
                                    }
                                    handler(kindName);
                                }
                            });
                        } else {
                            vscode.window.showQuickPick(names).then((name) => {
                                if (name) {
                                    let kindName = kind + '/' + name;
                                    handler(kindName);
                                }
                            });
                        }
                    } else {
                        vscode.window.showInformationMessage("No resources of type " + resourceKind.displayName + " in cluster");
                    }
                } else {
                    vscode.window.showErrorMessage(stderr);
                }
            });
        }
    });
}

function containsName(kindName) {
    if (typeof kindName === 'string' || kindName instanceof String) {
        return kindName.indexOf('/') > 0;
    }
    return false;
}

function parseNamesFromKubectlLines(text) {
    let lines = text.split('\n');
    lines.shift();

    let names = lines.filter((line) => {
        return line.length > 0;
    }).map((line) => {
        return parseName(line);
    });

    return names;
}

function parseName(line) {
    return line.split(' ')[0];
}

function curry(fn, arg) {
    return () => {
        let args = Array.prototype.slice.call(arguments, 0);
        args.push(arg);
        return fn.apply(null, args);
    }
}

function findPod(callback) {
    let editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor!');
        return null; // No open text editor
    }

    let text = editor.document.getText();
    try {
        let obj = yaml.safeLoad(text);
        if (obj.kind !== 'Pod') {
            return;
        }

        callback({
            name: obj.metadata.name,
            namespace: obj.metadata.namespace
        });
        return;
    } catch (ex) {
        // pass
    }

    selectPodForApp((pod) => {
        callback(pod.metadata);
    });
}

function selectPodForApp(callback) {
    findPodsForApp((podList) => {
        if (podList.items.length === 0) {
            vscode.window.showErrorMessage('Couldn\'t find any relevant pods.');
            callback(null);
            return;
        }
        if (podList.items.length === 1) {
            callback(podList.items[0]);
            return;
        }
        let names = [];

        for (const element of podList) {
            names.push(`${element.metadata.namespace}/${element.metadata.name}`);
        }

        vscode.window.showQuickPick(names).then((value) => {
            if (!value) {
                callback(null);
                return;
            }

            let ix = value.indexOf('/');
            let name = value.substring(ix + 1);

            for (const element of podList) {
                if (element.name !== name) {
                    continue;
                }

                callback(element);
                return;
            }

            callback(null);
        });
    });
}

function logsKubernetes() {
    findPod(getLogs);
}

function getLogs(pod) {
    if (!pod) {
        vscode.window.showErrorMessage('Can\'t find a pod!');
        return;
    }
    // TODO: Support multiple containers here!

    let cmd = ' logs ' + pod.name;
    if (pod.namespace && pod.namespace.length > 0) {
        cmd += ' --namespace=' + pod.namespace;
    }
    let fn = curry(kubectlOutput, pod.name + '-output');
    kubectlInternal(cmd, fn);
}

function kubectlOutput(result, stdout, stderr, name) {
    if (result !== 0) {
        vscode.window.showErrorMessage('Command failed: ' + stderr);
        return;
    }
    showOutput(stdout, name);
}

function showOutput(text, name) {
    let channel = vscode.window.createOutputChannel(name)
    channel.append(text);
    channel.show();
}

function getPorts() {
    let file = vscode.workspace.rootPath + '/Dockerfile';
    if (!fs.existsSync(file)) {
        return null;
    }
    try {
        let data = fs.readFileSync(file, 'utf-8');
        let obj = dockerfileParse(data);
        return obj.expose;
    } catch (ex) {
        console.log(ex);
        return null;
    }
}

function describeKubernetes() {
    findKindNameOrPrompt(kuberesources.commonKinds, 'describe', { nameOptional: true }, (value) => {
        const fn = curry(kubectlOutput, value + "-describe");
        kubectlInternal(' describe ' + value, fn);
    });
}

function selectContainerForPod(pod, callback) {
    if (!pod) {
        callback(null);
    }
    if (pod.spec.containers.length === 1) {
        callback(pod.spec.containers[0]);
        return;
    }
    let names = [];

    for (const element of pod.spec.containers) {
        names.push(element.name);
    }

    vscode.window.showQuickPick(names).then((value) => {
        for (const element of pod.spec.containers) {
            if (element.name !== value) {
                continue;
            }

            callback(element);
            return;
        }

        callback(null);
    });
}

function execKubernetes() {
    execKubernetesCore(false);
}

function terminalKubernetes() {
    execKubernetesCore(true);
}

function execKubernetesCore(isTerminal) {
    let opts: any = { prompt: 'Please provide a command to execute' };

    if (isTerminal) {
        opts.value = 'bash';
    }

    vscode.window.showInputBox(
        opts
    ).then((cmd) => {
        if (!cmd || cmd.length === 0) {
            return;
        }

        selectPodForApp((pod) => {
            if (!pod || !pod.metadata) {
                return;
            }

            if (isTerminal) {
                const terminalExecCmd : string[] = ['exec', '-it', pod.metadata.name, cmd];
                const term = vscode.window.createTerminal('exec', kubectlPath(), terminalExecCmd);
                term.show();
                return;
            }

            const execCmd = ' exec ' + pod.metadata.name + ' ' + cmd;
            let fn = curry(kubectlOutput, pod.metadata.name + '-exec')
            kubectlInternal(execCmd, fn);
        });
    });
}

function syncKubernetes() {
    selectPodForApp((pod) => {
        selectContainerForPod(pod, (container) => {
            let pieces = container.image.split(':');
            if (pieces.length !== 2) {
                vscode.window.showErrorMessage(`unexpected image name: ${container.image}`);
                return;
            }

            const cmd = `git checkout ${pieces[1]}`;

            //eslint-disable-next-line no-unused-vars
            shell.execCore(cmd, shell.execOpts(), (code, stdout, stderr) => {
                if (code !== 0) {
                    vscode.window.showErrorMessage(`git checkout returned: ${code}`);
                    return 'error';
                }
            });
        });
    });
}

function findBinary(binName, callback) {
    let cmd = `which ${binName}`

    if (process.platform === WINDOWS) {
        cmd = `where.exe ${binName}.exe`;
    }

    const opts = {
        async: true,
        env: {
            HOME: process.env.HOME,
            PATH: process.env.PATH
        }
    }

    shell.execCore(cmd, opts, (code, stdout, stderr) => {
        if (code) {
            callback(code, stderr);
            return;
        }

        callback(null, stdout);
    });
}

const deleteKubernetes = () => {
    findKindNameOrPrompt(kuberesources.commonKinds, 'delete', { nameOptional: true }, (kindName) => {
        if (kindName) {
            let commandArgs = kindName;
            if (!containsName(kindName)) {
                commandArgs = kindName + " --all";
            }
            kubectl('delete ' + commandArgs);
        }
    });
}

const applyKubernetes = () => {
    diffKubernetes(() => {
        vscode.window.showInformationMessage(
            'Do you wish to apply this change?',
            'Apply'
        ).then((result) => {
            if (result !== 'Apply') {
                return;
            }

            maybeRunKubernetesCommandForActiveWindow('apply -f');
        });
    });
};

const handleError = (err) => {
    if (err) {
        vscode.window.showErrorMessage(err);
    }
};

const diffKubernetes = (callback) => {
    getTextForActiveWindow((data, file) => {
        console.log(data, file);
        let kindName = null;
        let fileName = null;

        if (data) {
            kindName = findKindNameForText(data);
            fileName = path.join(os.tmpdir(), 'local.json');
            fs.writeFile(fileName, data, handleError);
        } else if (file) {
            kindName = findKindName();
            fileName = file;
        } else {
            vscode.window.showInformationMessage('Nothing to diff.');
            return;
        }

        if (!kindName) {
            vscode.window.showWarningMessage('Could not find a valid API object');
            return;
        }

        kubectlInternal(` get -o json ${kindName}`, (result, stdout, stderr) => {
            if (result !== 0) {
                vscode.window.showErrorMessage('Error running command: ' + stderr);
                return;
            }

            let otherFile = path.join(os.tmpdir(), 'server.json');
            fs.writeFile(otherFile, stdout, handleError);

            vscode.commands.executeCommand(
                'vscode.diff',
                vscode.Uri.parse('file://' + otherFile),
                vscode.Uri.parse('file://' + fileName)).then((result) => {
                    console.log(result);
                    if (!callback) {
                        return;
                    }

                    callback();
                });
        });
    });
};

const debugKubernetes = () => {
    buildPushThenExec(_debugInternal);
}

const _debugInternal = (name, image) => {
    // TODO: optionalize/customize the '-debug'
    // TODO: make this smarter.
    vscode.window.showInputBox({
        prompt: 'Debug command for your container:',
        placeHolder: 'Example: node debug server.js' }
    ).then((cmd) => {
        if (!cmd) {
            return;
        }

        _doDebug(name, image, cmd);
    });
};

const _doDebug = (name, image, cmd) => {
    const deploymentName = `${name}-debug`;
    const runCmd = `run ${deploymentName} --image=${image} -i --attach=false -- ${cmd}`;
    console.log(runCmd);

    kubectlInternal(runCmd, (result, stdout, stderr) => {
        if (result !== 0) {
            vscode.window.showErrorMessage('Failed to start debug container: ' + stderr);
            return;
        }

        findDebugPodsForApp((podList) => {
            if (podList.items.length === 0) {
                vscode.window.showErrorMessage('Failed to find debug pod.');
                return;
            }

            let podName = podList.items[0].metadata.name;
            vscode.window.showInformationMessage('Debug pod running as: ' + podName);

            waitForRunningPod(podName, () => {
                kubectl(` port-forward ${podName} 5858:5858 8000:8000`);

                vscode.commands.executeCommand(
                    'vscode.startDebug',
                    {
                        type: 'node',
                        request: 'attach',
                        name: 'Attach to Process',
                        port: 5858,
                        localRoot: vscode.workspace.rootPath,
                        remoteRoot: '/'
                    }
                ).then(() => {
                    vscode.window.showInformationMessage('Debug session established', 'Expose Service').then((opt) => {
                        if (opt !== 'Expose Service') {
                            return;
                        }

                        vscode.window.showInputBox({ prompt: 'Expose on which port?', placeHolder: '80' }).then((port) => {
                            if (!port) {
                                return;
                            }

                            const exposeCmd = `expose deployment ${deploymentName} --type=LoadBalancer --port=${port}`;
                            kubectlInternal(exposeCmd, (result, stdout, stderr) => {
                                if (result !== 0) {
                                    vscode.window.showErrorMessage('Failed to expose deployment: ' + stderr);
                                    return;
                                }
                                vscode.window.showInformationMessage('Deployment exposed. Run Kubernetes Get > service ' + deploymentName + ' for IP address');
                            });
                        });
                    });
                }, (err) => {
                    vscode.window.showInformationMessage('Error: ' + err.message);
                });
            });
        });
    });
};

const waitForRunningPod = (name, callback) => {
    kubectlInternal(` get pods ${name} -o jsonpath --template="{.status.phase}"`,
        (result, stdout, stderr) => {
            if (result !== 0) {
                vscode.window.showErrorMessage(`Failed to run command (${result}) ${stderr}`);
                return;
            }

            if (stdout === 'Running') {
                callback();
                return;
            }

            setTimeout(() => waitForRunningPod(name, callback), 1000);
        });
};

function exists(kind, name, handler) {
    //eslint-disable-next-line no-unused-vars
    kubectlInternal('get ' + kind + ' ' + name, (result) => {
        handler(result === 0);
    });
}

function deploymentExists(deploymentName, handler) {
    exists('deployments', deploymentName, handler);
}

function serviceExists(serviceName, handler) {
    exists('services', serviceName, handler);
}

function removeDebugKubernetes() {
    //eslint-disable-next-line no-unused-vars
    findNameAndImage().then((name, image) => {
        let deploymentName = name + '-debug';
        deploymentExists(deploymentName, (deployment) => {
            serviceExists(deploymentName, (service) => {
                if (!deployment && !service) {
                    vscode.window.showInformationMessage(deploymentName + ': nothing to clean up');
                    return;
                }

                let toDelete = deployment ? ('deployment' + (service ? ' and service' : '')) : 'service';
                vscode.window.showWarningMessage('This will delete ' + toDelete + ' ' + deploymentName, 'Delete').then((opt) => {
                    if (opt !== 'Delete') {
                        return;
                    }

                    if (service) {
                        kubectl('delete service ' + deploymentName);
                    }

                    if (deployment) {
                        kubectl('delete deployment ' + deploymentName);
                    }
                });
            })
        });
    });
}

function configureFromAcsKubernetes() {
    acsShowProgress("Verifying prerequisites...");
    acs.verifyPrerequisites(
        () => {
            acsSelectSubscription();
        },
        (errs : Array<string>) => {
            if (errs.length === 1) {
                acsShowError('Missing prerequisite for Kubernetes configuration. ' + errs[0], errs[0]);
            } else {
                acsShowError('Missing prerequisites for Kubernetes configuration. See Output window for details.', errs.join('\n'));
            }
        }
    );
}

function acsSelectSubscription() {
    acsShowProgress("Retrieving Azure subscriptions...");
    acs.selectSubscription(
        (subName) => {
            acsSelectCluster(subName);
        },
        () => {
            vscode.window.showInformationMessage('No Azure subscriptions.');
        },
        (err) => {
            acsShowError('Unable to list Azure subscriptions. See Output window for error.', err);
        }
    );
}

function acsSelectCluster(subName) {
    acsShowProgress("Retrieving Azure Container Service Kubernetes clusters...");
    acs.selectKubernetesClustersFromActiveSubscription(
        (cluster) => {
            acsInstallCli();
            acsGetCredentials(cluster);
        },
        () => {
            vscode.window.showInformationMessage('No Kubernetes clusters in subscription ' + subName);
        },
        (err) => {
            acsShowError('Unable to select a Kubernetes cluster in ' + subName + '. See Output window for error.', err);
         }
     );
}

function acsInstallCli() {
    acsShowProgress("Downloading kubectl command line tool...");
    acs.installCli(
        (installLocation, onDefaultPath) => {
            let message = 'kubectl installed.';
            let details = 'kubectl installation location: ' + installLocation;
            if (onDefaultPath) {
                message = message + ' See Output window for details.';
            } else {
                message = message + ' See Output window for additional installation info.';
                details = details + '\n***NOTE***: This location is not on your system PATH.\nAdd this directory to your path, or set the VS Code\n*vs-kubernetes.kubectl-path* config setting.';
                acsShowOutput(details);
            }
            vscode.window.showInformationMessage(message);
        },
        (err) => {
            acsShowError('Unable to download kubectl. See Output window for error.', err);
        }
    );
}

function acsGetCredentials(cluster) {
    acsShowProgress("Configuring Kubernetes credentials for " + cluster.name + "...");
    acs.getCredentials(cluster,
        () => {
            vscode.window.showInformationMessage('Successfully configured kubectl with Azure Container Service cluster credentials.');
        },
        (err) => {
            acsShowError('Unable to get Azure Container Service cluster credentials. See Output window for error.', err);
        });
}

function acsShowProgress(message) {
    acsShowOutput(message);
}

function acsShowError(message, err) {
    vscode.window.showErrorMessage(message);
    acsShowOutput(err);
}

let _acsOutputChannel : vscode.OutputChannel = null;

function acsShowOutput(message) {
    if (!_acsOutputChannel) {
        _acsOutputChannel = vscode.window.createOutputChannel('Kubernetes Configure from ACS');
    }
    _acsOutputChannel.appendLine(message);
    _acsOutputChannel.show();
}