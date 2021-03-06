"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const utils = require("@iobroker/adapter-core");
const SerialPort = require("serialport");
var ByteLength = require('@serialport/parser-byte-length');
const DatagramUtils_1 = require("./DatagramUtils");
class ValloxSerial extends utils.Adapter {
    /**
     * Constructor: Bind event handlers.
     *
     * @param options
     */
    constructor(options = {}) {
        super(Object.assign(Object.assign({}, options), { name: "valloxserial" }));
        this.datagramStateMap = [];
        // set serial out of synch
        this.serialinsync = false;
        this.on("ready", this.onReady.bind(this));
        this.on("objectChange", this.onObjectChange.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.buildDatagramStateMap();
    }
    /**
     * Monitor all stuff that happens with the serial port.
     */
    bindPortEvents() {
        this.serialPort.on('error', (err) => {
            this.log.error(`PROBLEM WITH SERIAL PORT: ${err.message}`);
            this.restart();
        });
        this.serialPort.on('open', () => {
            this.logSerialPortEvent("Serial port opened");
        });
        this.serialPort.on('close', () => {
            this.logSerialPortEvent("Serial port closed");
        });
        this.serialPort.on('pause', () => {
            this.logSerialPortEvent("Serial port paused");
        });
    }
    /**
     * Is called when databases are connected and adapter received configuration.
     */
    onReady() {
        return __awaiter(this, void 0, void 0, function* () {
            this.logEventHandlers("onReady() called.");
            this.logSerialPortEvent(`Opening serial port ${this.config.serialPortDevice} at 9600 bit/s, 8 databits, no parity, 1 stop bit.`);
            this.serialPort = new SerialPort(this.config.serialPortDevice, {
                autoOpen: true,
                baudRate: 9600,
                dataBits: 8,
                parity: 'none',
                stopBits: 1
            });
            this.bindPortEvents();
            // initialize and pipe serial port input through DelimiterParser
            this.datagramSource = this.serialPort.pipe(new SerialPort.parsers.Delimiter(
            /* Datagrams start with a 0x01 byte, so we use a
               Delimiter parser for separating datagrams */
            { delimiter: [0x1] }));
            this.datagramSource.on("data", this.onDataReady.bind(this));
            // Subscribe to all writable states
            this.subscribeStatesAsync(`${this.namespace}.Commands.*`);
        });
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    onUnload(callback) {
        try {
            this.logEventHandlers("onUnload() called.");
            this.serialPort.pause();
            this.serialPort.close();
            this.log.info("cleaned everything up...");
            callback();
        }
        catch (e) {
            callback();
        }
    }
    onDataReady(data) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.serialinsync == false) {
                this.log.info(`Serial out of synch.`);
                if (DatagramUtils_1.DatagramUtils.hasRightChecksum(data)) {
                    this.serialinsync = true;
                    this.serialPort.pause();
                    this.serialPort.close();
                    this.serialPort = new SerialPort(this.config.serialPortDevice, {
                        autoOpen: true,
                        baudRate: 9600,
                        dataBits: 8,
                        parity: 'none',
                        stopBits: 1
                    });
                    this.bindPortEvents();
                    this.datagramSource = this.serialPort.pipe(new ByteLength({ length: 6 }));
                    this.datagramSource.on("data", this.onDataReady.bind(this));
                    this.log.info(`Serial in synch.`);
                }
                // discard everything until in synch
                return;
            }
            let datagramString = DatagramUtils_1.DatagramUtils.toHexStringDatagram(data);
            this.logEventHandlers(`onDataReady([${datagramString}]) called.`);
            this.logDatagram(datagramString);
            // check if still in synch 
            if (data[0] == 1) {
                //to keep existing code working: shift data by one byte 
                data[0] = data[1];
                data[1] = data[2];
                data[2] = data[3];
                data[3] = data[4];
                data[4] = data[5];
                // check checksum
                if (DatagramUtils_1.DatagramUtils.hasRightChecksum(data)) {
                    // only look at datagrams that are sent by the main unit
                    if (DatagramUtils_1.DatagramUtils.decodeAddressToControlUnit(data[0]) == "MainUnit") {
                        let mappings = this.getDatagramMappingsByRequestCode(data[2]);
                        for (let mapping of mappings) {
                            let objectId = mapping.id;
                            let reading = (!!mapping.fieldBitPattern) ?
                                mapping.encoding(data[3], mapping.fieldBitPattern) :
                                mapping.encoding(data[3]);
                            if (this.config.logAllReadingsForStateChange) {
                                this.log.info(`Reading (code: ${DatagramUtils_1.DatagramUtils.toHexString(data[2], true)}, val: ${data[3]}) => to Object ${objectId}. Encoded value: ${reading}.`);
                            }
                            try {
                                if (this.config.logAllReadingsForStateChange) {
                                    this.log.info(`objectid: ${objectId}`);
                                }
                                if (objectId.split('.')[0] != "Commands") { // Update only Readings
                                    let stateChange = yield this.setStateChangedAsync(objectId, reading, true);
                                    let stateChangeString = JSON.stringify(stateChange);
                                    if (this.config.logAllReadingsForStateChange) {
                                        this.log.info(`Object ${objectId} state changed to ${stateChangeString}`);
                                    }
                                }
                            }
                            catch (err) {
                                this.log.info(`Unable to change state of ${objectId}: ${err}`);
                            }
                        }
                        if (mappings.length == 0) {
                            this.log.warn("No mapping found for code " + DatagramUtils_1.DatagramUtils.toHexString(data[2], true) + `. Datagram was ${datagramString}`);
                        }
                    }
                }
                else {
                    this.log.warn(`Checksum of datagram ${datagramString} is not correct.`);
                }
            }
            else { // port out of synch
                this.serialinsync = false;
                // switch to delimiter parser
                this.serialPort.pause();
                this.serialPort.close();
                this.serialPort = new SerialPort(this.config.serialPortDevice, {
                    autoOpen: true,
                    baudRate: 9600,
                    dataBits: 8,
                    parity: 'none',
                    stopBits: 1
                });
                this.bindPortEvents();
                // initialize and pipe serial port input through DelimiterParser
                this.datagramSource = this.serialPort.pipe(new SerialPort.parsers.Delimiter(
                /* Datagrams start with a 0x01 byte, so we use a
                  Delimiter parser for separating datagrams */
                { delimiter: [0x1] }));
                this.datagramSource.on("data", this.onDataReady.bind(this));
            }
        });
    }
    /**
     * Is called if a subscribed object changes
     */
    onObjectChange(id, obj) {
        this.logEventHandlers(`onObjectChange(id: ${id}, obj: ${JSON.stringify(obj)}) called.`);
        if (obj) {
            // The object was changed
            this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        }
        else {
            // The object was deleted
            this.log.info(`object ${id} deleted`);
        }
    }
    /**
     * Is called if a subscribed state changes
     */
    onStateChange(id, state) {
        this.logEventHandlers(`onStateChange(id: ${id}, state: ${JSON.stringify(state)}) called.`);
        if (state && state.val) {
            if (this.isCommand(state)) {
                // The state was changed
                this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                let datagram = [0x01, // Domain, always 0x01
                    DatagramUtils_1.DatagramUtils.encodeControlUnitToAddress(this.config.controlUnitAddress), // act as panel
                    0x11,
                    this.getCommandFieldCode(id),
                    0xFF,
                    0xFF]; // placeholder for checksum
                if (state.val >= 0 && state.val <= 8) {
                    datagram[4] = DatagramUtils_1.DatagramUtils.encodeFanSpeed(+state.val);
                    DatagramUtils_1.DatagramUtils.addChecksum(datagram);
                    DatagramUtils_1.DatagramUtils.toHexStringDatagram(datagram);
                    this.serialPort.write(datagram, (error, bytesWritten) => {
                        if (!!error) {
                            this.log.error(`ERROR WHEN WRITING TO SERIAL PORT: ${error}`);
                        }
                        else {
                            this.log.debug(`Datagram ${DatagramUtils_1.DatagramUtils.toHexStringDatagram(datagram)} successfully sent.`);
                        }
                    });
                }
            }
        }
        else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }
    // ////////////////////////////////////////////////////////////////
    // Section with local helpers
    // ////////////////////////////////////////////////////////////////
    /**
     * Fills the member variablethis.datagramStateMap with a mapping from
     * datagram request codes to object IDs. Therefore the instanceObjects
     * configuration from io-package.json is read.
     */
    buildDatagramStateMap() {
        var _a, _b, _c, _d, _e, _f;
        for (let obj of this.ioPack.instanceObjects) {
            let enc = (_b = (_a = obj === null || obj === void 0 ? void 0 : obj.common) === null || _a === void 0 ? void 0 : _a.custom) === null || _b === void 0 ? void 0 : _b.encoding;
            let decodingFunction = DatagramUtils_1.DatagramUtils.getDecodeFunctionByName(enc);
            let codes = ((_d = (_c = obj === null || obj === void 0 ? void 0 : obj.common) === null || _c === void 0 ? void 0 : _c.custom) === null || _d === void 0 ? void 0 : _d.fieldCodes) || [];
            for (let code of codes) {
                let bitPatternValue = (!!((_f = (_e = obj === null || obj === void 0 ? void 0 : obj.common) === null || _e === void 0 ? void 0 : _e.custom) === null || _f === void 0 ? void 0 : _f.fieldBitPattern)) ?
                    parseInt(obj.common.custom.fieldBitPattern) : undefined;
                this.datagramStateMap.push({ fieldCode: +code, fieldBitPattern: bitPatternValue, id: obj._id, encoding: decodingFunction });
            }
        }
    }
    getDatagramMappingsByRequestCode(fieldCode) {
        let result = [];
        for (let mapping of this.datagramStateMap) {
            if (mapping.fieldCode == fieldCode) {
                result.push(mapping);
            }
        }
        return result;
    }
    getCommandFieldCode(objectId) {
        let result = 0x00; // invalid field code
        for (let obj of this.ioPack.instanceObjects) {
            if (obj.type == "state" && obj._id == objectId) {
                return result = parseInt(obj.common.custom.fieldCodes[0]);
            }
        }
        return result;
    }
    isCommand(state) {
        return (!!state && state.ack == false);
    }
    // ////////////////////////////////////////////////////////////////
    // Section with debug logging functions
    // ////////////////////////////////////////////////////////////////
    logDatagram(datagramString) {
        let ll = this.config.loglevelDatagrams;
        let logFunc = (ll == "Silly") ?
            this.log.silly : (ll == "Debug") ?
            this.log.debug : (ll == "Info") ?
            this.log.info :
            undefined;
        if (!!logFunc) {
            logFunc(`Received datagram: ${datagramString}`);
        }
    }
    logSerialPortEvent(msg) {
        if (this.config.logSerialPortEvents) {
            this.log.info(msg);
        }
    }
    logEventHandlers(msg) {
        if (this.config.logEventHandlers) {
            this.log.info(msg);
        }
    }
}
if (module.parent) {
    // Export the constructor in compact mode
    module.exports = (options) => new ValloxSerial(options);
}
else {
    // otherwise start the instance directly
    (() => new ValloxSerial())();
}
//# sourceMappingURL=main.js.map