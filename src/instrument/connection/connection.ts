import { observable, computed, action, autorun, toJS } from "mobx";
import { bind } from "bind-decorator";

import { IActivityLogEntry, log } from "shared/activity-log";
import { registerSource, unregisterSource, sendMessage, watch } from "shared/notify";
import { isRenderer } from "shared/util";

import { InstrumentObject } from "instrument/instrument-object";
import { CONF_COMBINE_IF_BELOW_MS } from "instrument/conf";
import { EthernetInterface } from "instrument/connection/interfaces/ethernet";
import { SerialInterface } from "instrument/connection/interfaces/serial";
import {
    CommunicationInterface,
    CommunicationInterfaceHost,
    ConnectionErrorCode,
    ConnectionParameters
} from "instrument/connection/interface";
import { FileUpload } from "instrument/connection/file-upload";
import { IFileDownloadInstructions, FileDownload } from "instrument/connection/file-download";
import { parseScpiValue } from "instrument/scpi";

////////////////////////////////////////////////////////////////////////////////

const CONF_HOUSEKEEPING_INTERVAL = 100;

const CONF_IDN_EXPECTED_TIMEOUT = 1000;

////////////////////////////////////////////////////////////////////////////////

export enum ConnectionState {
    IDLE,
    CONNECTING,
    CONNECTED,
    DISCONNECTING
}

export interface ConnectionStatus {
    state: ConnectionState;
    errorCode: ConnectionErrorCode;
    error: string | undefined;
}

abstract class ConnectionBase {
    constructor(public instrument: InstrumentObject) {}

    abstract get state(): ConnectionState;
    abstract get errorCode(): ConnectionErrorCode;
    abstract get error(): string | undefined;

    abstract dismissError(): void;

    @computed
    get isIdle() {
        return this.state === ConnectionState.IDLE;
    }

    @computed
    get isTransitionState() {
        return (
            this.state === ConnectionState.CONNECTING ||
            this.state === ConnectionState.DISCONNECTING
        );
    }

    @computed
    get isConnected() {
        return this.state === ConnectionState.CONNECTED;
    }

    abstract connect(connectionParameters?: ConnectionParameters): void;
    abstract disconnect(): void;
    abstract destroy(): void;
    abstract send(command: string): void;
    abstract download(instructions: IFileDownloadInstructions): void;
    abstract abortLongOperation(): void;

    abstract acquire(callbackWindowId: number, traceEnabled: boolean): string | null;
    abstract release(): void;
}

export type IConnection = ConnectionBase;

export interface LongOperation {
    logId: string;
    logEntry: Partial<IActivityLogEntry>;
    abort(): void;
    onData(data: string): void;
    isDone(): boolean;
    dataSurplus: string | undefined;
}

export class Connection extends ConnectionBase implements CommunicationInterfaceHost {
    @observable _state: ConnectionState = ConnectionState.IDLE;
    get state() {
        return this._state;
    }
    set state(state: ConnectionState) {
        action(() => {
            this._state = state;
        })();
    }

    @observable _errorCode: ConnectionErrorCode = ConnectionErrorCode.NONE;
    get errorCode() {
        return this._errorCode;
    }
    set errorCode(errorCode: ConnectionErrorCode) {
        action(() => {
            this._errorCode = errorCode;
        })();
    }

    @observable _error: string | undefined;
    get error() {
        return this._error;
    }
    set error(error: string | undefined) {
        action(() => {
            this._error = error;
        })();
    }

    dismissError() {
        this.error = undefined;
    }

    setError(errorCode: ConnectionErrorCode, error: string | undefined) {
        this.errorCode = errorCode;
        this.error = error;
    }

    communicationInterface: CommunicationInterface | undefined;
    disposer: any;
    notifySource: any;
    wasConnected = false;
    connectedStartTime: number;
    data: string | undefined;
    idnExpected: boolean;
    idnExpectedTimeout: any;
    dataTimeoutId: any;
    longOperation: LongOperation | undefined;
    connectionParameters: ConnectionParameters;
    housekeepingIntervalId: any;
    callbackWindowId: number | undefined;
    traceEnabled: boolean = true;

    constructor(public instrument: InstrumentObject) {
        super(instrument);

        this.notifySource = {
            id: "instrument/" + this.instrument.id + "/connection",
            onNewTarget: (targetId: string, filterSpecification: any, inProcessTarget: boolean) => {
                this.sendConnectionStatusMessage(targetId);
            }
        };
        registerSource(this.notifySource);

        this.disposer = autorun(() => {
            this.sendConnectionStatusMessage();
        });

        if (instrument.lastConnection && instrument.autoConnect) {
            this.connect();
        }
    }

    destroy() {
        this.disconnect();
        this.disposer();
        unregisterSource(this.notifySource);
    }

    sendConnectionStatusMessage(targetId?: string) {
        let connectionStatus: ConnectionStatus = {
            state: this.state,
            errorCode: this.errorCode,
            error: this.error
        };
        sendMessage(this.notifySource, connectionStatus, targetId);
    }

    connect() {
        if (this.state !== ConnectionState.IDLE) {
            console.error("invalid state (connect)");
            return;
        }

        this.state = ConnectionState.CONNECTING;
        this.errorCode = ConnectionErrorCode.NONE;
        this.error = undefined;

        this.connectionParameters = this.instrument.lastConnection as ConnectionParameters;

        if (this.connectionParameters.type === "ethernet") {
            this.communicationInterface = new EthernetInterface(this);
        } else {
            this.communicationInterface = new SerialInterface(this);
        }

        this.communicationInterface!.connect();
    }

    connected() {
        this.state = ConnectionState.CONNECTED;

        log(
            {
                oid: this.instrument.id,
                type: "instrument/connected",
                message: JSON.stringify({
                    connectionParameters: toJS(this.connectionParameters)
                })
            },
            {
                undoable: false
            }
        );

        this.wasConnected = true;
        this.connectedStartTime = new Date().getTime();

        this.sendIdn();

        this.housekeepingIntervalId = setInterval(this.housekeeping, CONF_HOUSEKEEPING_INTERVAL);
    }

    logRequest(data: string) {
        if (this.traceEnabled) {
            log(
                {
                    oid: this.instrument.id,
                    type: "instrument/request",
                    message: data
                },
                {
                    undoable: false
                }
            );
        }
    }

    logAnswer(data: string) {
        if (this.traceEnabled) {
            log(
                {
                    oid: this.instrument.id,
                    type: "instrument/answer",
                    message: data
                },
                {
                    undoable: false
                }
            );
        }
    }

    sendValue(value: any) {
        if (this.callbackWindowId) {
            let browserWindow = require("electron").BrowserWindow.fromId(this.callbackWindowId);
            browserWindow.webContents.send("instrument/connection/value", value);
        }
    }

    longOperationDone() {
        this.sendValue({ logEntry: this.longOperation!.logEntry });
        this.longOperation = undefined;
    }

    onDataLineReceived(data: string) {
        this.logAnswer(data);

        const value = parseScpiValue(data);

        this.sendValue(value);

        if (this.idnExpected) {
            clearTimeout(this.idnExpectedTimeout);
            this.idnExpectedTimeout = undefined;
            this.idnExpected = false;

            if (typeof value !== "string") {
                this.setError(ConnectionErrorCode.NONE, "Invalid IDN value.");
                this.disconnect();
            } else {
                this.instrument.setIdn(value);
            }
        }
    }

    flushData() {
        if (this.longOperation) {
            this.longOperation.abort();
            this.longOperation = undefined;
        }

        if (this.dataTimeoutId) {
            clearTimeout(this.dataTimeoutId);
            this.dataTimeoutId = undefined;
        }

        if (this.data) {
            this.logAnswer(this.data);
            this.data = undefined;
        }
    }

    @bind
    housekeeping() {
        if (this.longOperation && this.longOperation.isDone()) {
            let dataSurplus = this.longOperation.dataSurplus;
            this.longOperationDone();
            this.data = dataSurplus;
        }
    }

    onData(data: string) {
        if (this.dataTimeoutId) {
            clearTimeout(this.dataTimeoutId);
        }

        if (this.longOperation) {
            this.longOperation.onData(data);
        } else if (this.data === undefined && data.startsWith("#")) {
            this.longOperation = new FileUpload(this, data);
        }

        if (this.longOperation) {
            if (!this.longOperation.isDone()) {
                return;
            }
            let dataSurplus = this.longOperation.dataSurplus;
            this.longOperationDone();
            if (dataSurplus === undefined) {
                return;
            }
            data = dataSurplus;
        }

        if (this.data === undefined) {
            this.data = data;
        } else {
            this.data += data;
        }

        let index = this.data.indexOf("\n");
        if (index !== -1) {
            ++index;
            let data = this.data.substr(0, index);
            if (index < this.data.length) {
                this.data = this.data.substr(index);
            } else {
                this.data = undefined;
            }

            this.onDataLineReceived(data);
        }

        if (this.data !== undefined) {
            this.dataTimeoutId = setTimeout(() => {
                this.flushData();
            }, CONF_COMBINE_IF_BELOW_MS);
        }
    }

    send(
        command: string,
        options?: {
            log?: boolean;
            longOperation?: boolean;
        }
    ): void {
        if (!options || options.log) {
            this.logRequest(command);
        }

        if (this.state !== ConnectionState.CONNECTED || !this.communicationInterface) {
            this.logAnswer("**ERROR: not connected\n");
            return;
        }

        if (!options || !options.longOperation) {
            if (this.longOperation) {
                if (
                    this.longOperation instanceof FileUpload ||
                    this.longOperation instanceof FileDownload
                ) {
                    this.logAnswer("**ERROR: file transfer in progress\n");
                } else {
                    this.logAnswer("**ERROR: another operation in progress\n");
                }
                return;
            }
        }

        this.errorCode = ConnectionErrorCode.NONE;
        this.error = undefined;

        this.communicationInterface.write(command + "\n");
    }

    sendIdn() {
        if (this.state !== ConnectionState.CONNECTED) {
            console.error("invalid state (this.state !== ConnectionState.CONNECTED)");
            return;
        }

        if (!this.communicationInterface) {
            console.error("invalid state (!this.connectionInterfaceImplementation)");
            return;
        }

        this.send("*IDN?");
        this.flushData();
        this.idnExpected = true;
        this.idnExpectedTimeout = setTimeout(() => {
            this.setError(ConnectionErrorCode.NONE, "Timeout (no response to IDN query).");
            this.disconnect();
        }, CONF_IDN_EXPECTED_TIMEOUT);
    }

    startLongOperation(createLongOperation: () => LongOperation) {
        if (this.state !== ConnectionState.CONNECTED || !this.communicationInterface) {
            throw "not connected";
        }

        if (this.longOperation) {
            if (
                this.longOperation instanceof FileUpload ||
                this.longOperation instanceof FileDownload
            ) {
                throw "file transfer in progress";
            } else {
                throw "another operation in progress";
            }
        }

        this.longOperation = createLongOperation();
    }

    download(instructions: IFileDownloadInstructions) {
        try {
            this.startLongOperation(() => new FileDownload(this, instructions));
        } catch (err) {
            this.logAnswer(`**ERROR: ${err}\n`);
        }
    }

    abortLongOperation() {
        if (this.longOperation) {
            this.longOperation.abort();
        }
    }

    disconnect() {
        if (this.state === ConnectionState.IDLE || !this.communicationInterface) {
            console.error("invalid state (disconnect)");
            return;
        }

        this.state = ConnectionState.DISCONNECTING;
        this.communicationInterface.disconnect();
    }

    disconnected() {
        this.communicationInterface = undefined;
        this.state = ConnectionState.IDLE;

        if (this.wasConnected) {
            this.flushData();

            let duration = new Date().getTime() - this.connectedStartTime;

            log(
                {
                    oid: this.instrument.id,
                    type: "instrument/disconnected",
                    message: JSON.stringify({
                        duration,
                        error: this.error
                    })
                },
                {
                    undoable: false
                }
            );
            this.wasConnected = false;
        } else {
            log(
                {
                    oid: this.instrument.id,
                    type: "instrument/connect-failed",
                    message: JSON.stringify({
                        connectionParameters: toJS(this.connectionParameters),
                        error: this.error
                    })
                },
                {
                    undoable: false
                }
            );
        }

        if (this.housekeepingIntervalId) {
            clearInterval(this.housekeepingIntervalId);
            this.housekeepingIntervalId = undefined;
        }
    }

    acquire(callbackWindowId: number, traceEnabled: true) {
        if (!this.isConnected) {
            return "not connected";
        }
        this.callbackWindowId = callbackWindowId;
        this.traceEnabled = traceEnabled;
        return null;
    }

    release() {
        this.callbackWindowId = undefined;
        this.traceEnabled = true;
    }
}

export class IpcConnection extends ConnectionBase {
    @observable state: ConnectionState = ConnectionState.IDLE;
    @observable errorCode: ConnectionErrorCode = ConnectionErrorCode.NONE;
    @observable error: string | undefined;

    constructor(instrument: InstrumentObject) {
        super(instrument);

        watch(
            "instrument/" + instrument.id + "/connection",
            undefined,
            action((connectionStatus: ConnectionStatus) => {
                this.state = connectionStatus.state;
                this.errorCode = connectionStatus.errorCode;
                this.error = connectionStatus.error;
            })
        );
    }

    dismissError() {
        EEZStudio.electron.ipcRenderer.send("instrument/connection/dismiss-error", {
            instrumentId: this.instrument.id
        });
    }

    connect(connectionParameters?: ConnectionParameters) {
        EEZStudio.electron.ipcRenderer.send("instrument/connection/connect", {
            instrumentId: this.instrument.id,
            connectionParameters
        });
    }

    disconnect() {
        EEZStudio.electron.ipcRenderer.send("instrument/connection/disconnect", {
            instrumentId: this.instrument.id
        });
    }

    destroy() {
        EEZStudio.electron.ipcRenderer.send("instrument/connection/destroy", {
            instrumentId: this.instrument.id
        });
    }

    send(command: string) {
        EEZStudio.electron.ipcRenderer.send("instrument/connection/send", {
            instrumentId: this.instrument.id,
            command
        });
    }

    download(instructions: IFileDownloadInstructions) {
        EEZStudio.electron.ipcRenderer.send("instrument/connection/download", {
            instrumentId: this.instrument.id,
            instructions
        });
    }

    abortLongOperation() {
        EEZStudio.electron.ipcRenderer.send("instrument/connection/abort-long-operation", {
            instrumentId: this.instrument.id
        });
    }

    acquire(callbackWindowId: number, traceEnabled: boolean) {
        return EEZStudio.electron.ipcRenderer.sendSync("instrument/connection/acquire", {
            instrumentId: this.instrument.id,
            callbackWindowId,
            traceEnabled
        });
    }

    release() {
        EEZStudio.electron.ipcRenderer.sendSync("instrument/connection/release", {
            instrumentId: this.instrument.id
        });
    }
}

export function setupIpcServer() {
    const { ipcMain } = require("electron");

    ipcMain.on("instrument/connection/connect", function(
        event: any,
        arg: {
            instrumentId: string;
            connectionParameters: any;
        }
    ) {
        let connection = connections.get(arg.instrumentId);
        if (connection) {
            if (arg.connectionParameters) {
                connection.instrument.setConnectionParameters(arg.connectionParameters);
            }
            connection.connect();
        }
    });

    ipcMain.on("instrument/connection/disconnect", function(
        event: any,
        arg: {
            instrumentId: string;
        }
    ) {
        let connection = connections.get(arg.instrumentId);
        if (connection) {
            connection.disconnect();
        }
    });

    ipcMain.on("instrument/connection/destroy", function(
        event: any,
        arg: {
            instrumentId: string;
        }
    ) {
        let connection = connections.get(arg.instrumentId);
        if (connection) {
            connection.destroy();
        }
    });

    ipcMain.on("instrument/connection/send", function(
        event: any,
        arg: {
            instrumentId: string;
            command: string;
        }
    ) {
        let connection = connections.get(arg.instrumentId);
        if (connection) {
            connection.send(arg.command);
        }
    });

    ipcMain.on("instrument/connection/download", function(
        event: any,
        arg: {
            instrumentId: string;
            instructions: IFileDownloadInstructions;
        }
    ) {
        let connection = connections.get(arg.instrumentId);
        if (connection) {
            connection.instrument.setLastFileDownloadInstructions(arg.instructions);
            connection.download(arg.instructions);
        }
    });

    ipcMain.on("instrument/connection/abort-long-operation", function(
        event: any,
        arg: {
            instrumentId: string;
        }
    ) {
        let connection = connections.get(arg.instrumentId);
        if (connection) {
            connection.abortLongOperation();
        }
    });

    ipcMain.on("instrument/connection/dismiss-error", function(
        event: any,
        arg: {
            instrumentId: string;
        }
    ) {
        let connection = connections.get(arg.instrumentId);
        if (connection) {
            connection.dismissError();
        }
    });

    ipcMain.on("instrument/connection/acquire", function(
        event: any,
        arg: {
            instrumentId: string;
            callbackWindowId: number;
            traceEnabled: boolean;
        }
    ) {
        let connection = connections.get(arg.instrumentId);
        if (connection) {
            event.returnValue = connection.acquire(arg.callbackWindowId, arg.traceEnabled);
        } else {
            event.returnValue = false;
        }
    });

    ipcMain.on("instrument/connection/release", function(
        event: any,
        arg: {
            instrumentId: string;
        }
    ) {
        let connection = connections.get(arg.instrumentId);
        if (connection) {
            connection.release();
        }
        event.returnValue = true;
    });
}

export const connections = observable(new Map<string, IConnection>());

export function createConnection(instrument: InstrumentObject) {
    let connection: IConnection;
    if (isRenderer()) {
        connection = new IpcConnection(instrument);
    } else {
        connection = new Connection(instrument);
    }

    action(() => {
        connections.set(instrument.id.toString(), connection);
    })();

    return connection;
}
