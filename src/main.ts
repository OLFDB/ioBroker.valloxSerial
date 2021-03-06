import * as utils from "@iobroker/adapter-core";
import * as SerialPort from "serialport";
var ByteLength = require ('@serialport/parser-byte-length');
import { DatagramUtils as dutils, DatagramSender, DatagramReceiver } from "./DatagramUtils";

// Augment the adapter.config object with the actual types
declare global {
	// eslint-disable-next-line @typescript-eslint/no-namespace
	namespace ioBroker {
		interface AdapterConfig {
			// Define the shape of your options here (recommended)
			serialPortDevice: string;
			loglevelDatagrams: "Off" | "Silly" | "Debug" | "Info";
			logSerialPortEvents: boolean;
			logEventHandlers: boolean;
			logAllReadingsForStateChange: boolean;
			controlUnitAddress: string;
		}
	}
}

type DatagramMapping = {
	"fieldCode": number;
	"fieldBitPattern": number | undefined;
	"id": string;
	"encoding": Function;
  }


class ValloxSerial extends utils.Adapter {
	// Member variables
	serialPort! : SerialPort
	datagramSource! : SerialPort.parsers.Delimiter;
	datagramStateMap: Array<DatagramMapping> = [];

	// synch serial port withn delimiter parser then change parser to length
	serialinsync : boolean;

	/**
	 * Constructor: Bind event handlers.
	 * 
	 * @param options 
	 */
	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: "valloxserial",
		});

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
	private bindPortEvents() {
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
	private async onReady(): Promise<void> {
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
			{ delimiter: [0x1] }
		));

		this.datagramSource.on("data", this.onDataReady.bind(this));

		// Subscribe to all writable states
		this.subscribeStatesAsync(`${this.namespace}.Commands.*`);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 */
	private onUnload(callback: () => void): void {
		try {
			this.logEventHandlers("onUnload() called.");

			this.serialPort.pause();
			this.serialPort.close();

			this.log.info("cleaned everything up...");
			callback();
		} catch (e) {
			callback();
		}
	}

	private async onDataReady(data : number[]): Promise<void> {

		if(this.serialinsync == false){

			this.log.info(`Serial out of synch.`);

			if(dutils.hasRightChecksum(data)) {
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

			this.datagramSource = this.serialPort.pipe(new ByteLength({length: 6}));

			this.datagramSource.on("data", this.onDataReady.bind(this));

			this.log.info(`Serial in synch.`);
			}

			// discard everything until in synch
			return;
		}

		let datagramString: string = dutils.toHexStringDatagram(data);
		this.logEventHandlers(`onDataReady([${datagramString}]) called.`);
		this.logDatagram(datagramString);

		// check if still in synch 
		if (data[0] == 1) {

			//to keep existing code working: shift data by one byte 

			data[0]=data[1];
			data[1]=data[2];
			data[2]=data[3];
			data[3]=data[4];
			data[4]=data[5];

			// check checksum
		  	if(dutils.hasRightChecksum(data)) {

				// only look at datagrams that are sent by the main unit
				if (dutils.decodeAddressToControlUnit(data[0]) == "MainUnit") {

					let mappings = this.getDatagramMappingsByRequestCode(data[2]);
					for (let mapping of mappings) {
						let objectId = mapping.id;
						let reading = (!!mapping.fieldBitPattern) ?
							mapping.encoding(data[3], mapping.fieldBitPattern) :
							mapping.encoding(data[3]);

						if (this.config.logAllReadingsForStateChange) {
							this.log.info(`Reading (code: ${dutils.toHexString(data[2], true)}, val: ${data[3]}) => to Object ${objectId}. Encoded value: ${reading}.`);
						}

						try {
							if (this.config.logAllReadingsForStateChange) {
								this.log.info(`objectid: ${objectId}`);
							}
							if(objectId.split('.')[0] != "Commands") { // Update only Readings
								let stateChange = await this.setStateChangedAsync(objectId, reading, true);
								let stateChangeString = JSON.stringify(stateChange);
								if (this.config.logAllReadingsForStateChange) {
									this.log.info(`Object ${objectId} state changed to ${stateChangeString}`);
								}
							}
						} catch (err) {
							this.log.info(`Unable to change state of ${objectId}: ${err}`);
						}
					}

					if (mappings.length == 0) {
						this.log.warn("No mapping found for code "+dutils.toHexString(data[2], true)+`. Datagram was ${datagramString}`);
					}
				} 
			} else {
				this.log.warn(`Checksum of datagram ${datagramString} is not correct.`);
			} 		
		} else { // port out of synch
			
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
				{ delimiter: [0x1] }
			));

			this.datagramSource.on("data", this.onDataReady.bind(this));

		}
	}

	/**
	 * Is called if a subscribed object changes
	 */
	private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
		this.logEventHandlers(`onObjectChange(id: ${id}, obj: ${JSON.stringify(obj)}) called.`);
		
		if (obj) {
			// The object was changed
			this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
		} else {
			// The object was deleted
			this.log.info(`object ${id} deleted`);
		}
	}

	/**
	 * Is called if a subscribed state changes
	 */
	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		this.logEventHandlers(`onStateChange(id: ${id}, state: ${JSON.stringify(state)}) called.`);
		
		if (state && state.val) {
			if (this.isCommand(state)) {
				// The state was changed
				this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

				let datagram : number[] = [0x01,  // Domain, always 0x01
										dutils.encodeControlUnitToAddress(this.config.controlUnitAddress as DatagramSender),  // act as panel
										0x11,  // send to ventilation unit
										this.getCommandFieldCode(id),  // set field, code for fan speed
										0xFF,  // placeholder for value
										0xFF]; // placeholder for checksum

				if (state.val >= 0 && state.val <= 8) {

					datagram[4] = dutils.encodeFanSpeed(+state.val)

					dutils.addChecksum(datagram);
  					dutils.toHexStringDatagram(datagram);

					this.serialPort.write(datagram, (error, bytesWritten) => {
						if (!!error) {
							this.log.error(`ERROR WHEN WRITING TO SERIAL PORT: ${error}`);
						} else {
							this.log.debug(`Datagram ${dutils.toHexStringDatagram(datagram)} successfully sent.`);
						}
					});
				}
			
			}
		} else {
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
	private buildDatagramStateMap(): void {
		for (let obj of this.ioPack.instanceObjects) {
			
			let enc = obj?.common?.custom?.encoding;
			let decodingFunction = dutils.getDecodeFunctionByName(enc);

			let codes = obj?.common?.custom?.fieldCodes || [];
			for (let code of codes) {
				let bitPatternValue: number | undefined = (!!obj?.common?.custom?.fieldBitPattern) ?
					parseInt(obj.common.custom.fieldBitPattern) : undefined;
				this.datagramStateMap.push({ fieldCode: +code, fieldBitPattern: bitPatternValue, id: obj._id, encoding: decodingFunction});
			}
		}
	}

	private getDatagramMappingsByRequestCode(fieldCode: number): Array<DatagramMapping> {
		let result = [];
		for (let mapping of this.datagramStateMap) {
		  if (mapping.fieldCode == fieldCode) {
			result.push(mapping);
		  }
		}
	  
		return result;
	}

	private getCommandFieldCode(objectId: string): number  {
		let result = 0x00; // invalid field code
		for (let obj of this.ioPack.instanceObjects) { 
			if (obj.type == "state" && obj._id == objectId) {
				return result = parseInt(obj.common.custom.fieldCodes[0]);
			}
		}
		return result;
	}

	private isCommand(state: ioBroker.State | null | undefined) : boolean {
		return (!!state && state.ack == false);
	}

	// ////////////////////////////////////////////////////////////////
	// Section with debug logging functions
	// ////////////////////////////////////////////////////////////////
	private logDatagram(datagramString : string) : void {
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

	private logSerialPortEvent(msg : string) :void {
		if (this.config.logSerialPortEvents) {
			this.log.info(msg);
		}
	}

	private logEventHandlers(msg : string) : void {
		if (this.config.logEventHandlers) {
			this.log.info(msg);
		}
	}


}



if (module.parent) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new ValloxSerial(options);
} else {
	// otherwise start the instance directly
	(() => new ValloxSerial())();
}