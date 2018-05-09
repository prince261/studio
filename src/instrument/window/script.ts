import { format } from "shared/units";
import { IActivityLogEntry, log, logUpdate, logDelete } from "shared/activity-log";

import * as NotificationModule from "shared/ui/notification";

import { validators } from "shared/model/validation";

import { IShortcut } from "shortcuts/interfaces";
import { confirm, info } from "shared/ui/dialog";
import { showGenericDialog } from "shared/ui/generic-dialog";

import { run as runScpi } from "shared/script-engines/scpi";
import { run as runJavaScript } from "shared/script-engines/javascript";

import { InstrumentObject } from "instrument/instrument-object";

import { getConnection } from "instrument/window/connection";
import { IScriptHistoryItemMessage } from "instrument/window/history-item";

import { showScriptError } from "instrument/window/scripts";

////////////////////////////////////////////////////////////////////////////////

function input(dialogDefinition: any, defaultValues: any): any {
    return new Promise<any>(resolve => {
        showGenericDialog({
            dialogDefinition,
            values: defaultValues
        })
            .then(result => {
                resolve(result.values);
            })
            .catch(() => {
                resolve(undefined);
            });
    });
}

////////////////////////////////////////////////////////////////////////////////

class ScpiSession {
    constructor(shortcut: IShortcut) {}

    set _scriptDone(value: boolean) {}

    set scriptError(value: string) {
        NotificationModule.error(value);
    }
}

function prepareScpiModules(instrument: InstrumentObject, shortcut: IShortcut) {
    const connection = getConnection(instrument);

    return {
        session: new ScpiSession(shortcut),

        connection: {
            acquire() {
                connection.acquire(true);
            },
            release() {
                connection.release();
            },
            command(command: string) {
                connection.command(command);
            }
        }
    };
}

////////////////////////////////////////////////////////////////////////////////

class JavaScriptSession {
    scriptLogId: string | undefined;
    scriptMessage: IScriptHistoryItemMessage;

    constructor(private instrument: InstrumentObject, shortcut: IShortcut) {
        this.scriptMessage = {
            name: shortcut.name,
            type: shortcut.action.type === "scpi-commands" ? "SCPI" : "JavaScript",
            done: false
        };

        this.scriptLogId = log(
            {
                oid: this.instrument.id,
                type: "instrument/script",
                message: JSON.stringify(this.scriptMessage)
            },
            {
                undoable: false
            }
        );
    }

    addChart(config: {
        description: string;
        data: any;
        samplingRate: number;
        offset: number;
        scale: number;
        format: number;
        unit: string;
        color?: string;
        colorInverse?: string;
        label?: string;
        viewOptions: {
            axesLines: {
                type: "fixed";
                majorSubdivision: {
                    horizontal: number;
                    vertical: number;
                };
                minorSubdivision: {
                    horizontal: number;
                    vertical: number;
                };
            };
        };
        horizontalScale: number;
        verticalScale: number;
    }) {
        const message: any = {
            direction: "upload",
            state: "success",
            fileType: { mime: "application/eez-raw" },
            description: config.description,
            waveformDefinition: {
                samplingRate: config.samplingRate,
                format: config.format !== undefined ? config.format : 2,
                unitName: config.unit.toLowerCase(),
                color: config.color,
                colorInverse: config.colorInverse,
                label: config.label,
                offset: config.offset,
                scale: config.scale
            },
            viewOptions: config.viewOptions,
            horizontalScale: config.horizontalScale,
            verticalScale: config.verticalScale
        };

        let data;
        if (Array.isArray(config.data)) {
            var dataBuffers = [];
            for (let i = 0; i < config.data.length; ++i) {
                if (typeof config.data[i] === "string") {
                    dataBuffers.push(new Buffer(config.data[i], "binary"));
                } else if (config.data[i] instanceof Buffer) {
                    dataBuffers.push(config.data[i]);
                } else {
                    console.log("UNKNOWN!!!");
                }
            }
            data = Buffer.concat(dataBuffers);
        } else if (typeof config.data === "string") {
            data = new Buffer(config.data, "binary");
        } else if (config.data instanceof Buffer) {
            data = config.data;
        } else {
            data = Buffer.from("");
        }

        message.dataLength = data.length;

        log(
            {
                oid: this.instrument.id,
                type: "instrument/file",
                message: JSON.stringify(message),
                data
            },
            {
                undoable: false
            }
        );
    }

    add(logEntry: IActivityLogEntry) {
        log(
            {
                id: logEntry.id,
                oid: logEntry.oid,
                type: logEntry.type,
                message: logEntry.message,
                data: logEntry.data
            },
            {
                undoable: false
            }
        );
    }

    private _updateLog() {
        if (this.scriptLogId) {
            logUpdate(
                {
                    id: this.scriptLogId,
                    oid: this.instrument.id,
                    message: JSON.stringify(this.scriptMessage)
                },
                {
                    undoable: false
                }
            );
        }
    }

    set scriptParameters(value: any) {
        this.scriptMessage.parameters = value;
        this._updateLog();
    }

    set _scriptDone(value: boolean) {
        this.scriptMessage.done = value;
        this._updateLog();
    }

    set scriptError(value: string) {
        this.scriptMessage.error = value;
        this._updateLog();
    }

    deleteScriptLogEntry() {
        logDelete(
            {
                id: this.scriptLogId,
                oid: this.instrument.id
            },
            {
                undoable: false
            }
        );
        this.scriptLogId = undefined;
    }
}

function prepareJavaScriptModules(instrument: InstrumentObject, shortcut: IShortcut) {
    return {
        session: new JavaScriptSession(instrument, shortcut),

        connection: getConnection(instrument),

        instrument: {
            get properties() {
                return instrument.properties;
            }
        },

        notify: NotificationModule,

        validators,

        input,

        format,

        storage: {
            getItem(key: string, defaultValue: any) {
                try {
                    const jsonValue = localStorage.getItem(
                        `instrument/${instrument.id}/scripts-storage/${key}`
                    );
                    if (jsonValue) {
                        return JSON.parse(jsonValue);
                    }
                } catch (err) {}
                return defaultValue;
            },

            setItem(key: string, value: any) {
                localStorage.setItem(
                    `instrument/${instrument.id}/scripts-storage/${key}`,
                    JSON.stringify(value)
                );
            }
        }
    };
}

////////////////////////////////////////////////////////////////////////////////

function prepareModules(instrument: InstrumentObject, shortcut: IShortcut) {
    if (shortcut.action.type === "scpi-commands") {
        return prepareScpiModules(instrument, shortcut);
    } else {
        return prepareJavaScriptModules(instrument, shortcut);
    }
}

function doExecuteShortcut(instrument: InstrumentObject, shortcut: IShortcut) {
    let run;

    if (shortcut.action.type === "scpi-commands") {
        run = runScpi;
    } else {
        run = runJavaScript;
    }

    const modules = prepareModules(instrument, shortcut);

    run(shortcut.action.data, modules)
        .then(() => {
            modules.session._scriptDone = true;
            console.log("Script execution done!");
        })
        .catch(err => {
            let lineNumber;
            let columnNumber;
            const match = err.stack.match(/\<anonymous\>\:(\d+)\:(\d+)/);
            if (match) {
                lineNumber = parseInt(match[1]) - 2;
                columnNumber = parseInt(match[2]);
            }

            modules.session.scriptError = err.message;
            modules.session._scriptDone = true;

            if (shortcut.action.type === "javascript") {
                showScriptError(shortcut, err.message, lineNumber, columnNumber);
            }
        });
}

export function executeShortcut(instrument: InstrumentObject, shortcut: IShortcut) {
    if (!getConnection(instrument).isConnected) {
        info("Not connected to the instrument.", undefined);
        return;
    }

    if (shortcut.requiresConfirmation) {
        confirm(`Do you want to execute "${shortcut.name}" shortcut?`, undefined, () =>
            doExecuteShortcut(instrument, shortcut)
        );
    } else {
        doExecuteShortcut(instrument, shortcut);
    }
}