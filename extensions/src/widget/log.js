import { Signal } from './signal.js';

/**
 * Log controls what is written to the console, and also routes those messages to the Editor's
 * console. Using these methods instead of console.log will let the message show up in the Editor.
 * @hideconstructor
 * @category Util
 */
export class Log {
  /**
   * Log a message directly.
   * @param {...*} msg message data to write
   */
  static write() {
    console.log(...arguments);
    Log.messages.push([Log.Message, arguments]);
    Log.onMessage.emit(Log.Message, arguments);
  }

  /**
   * Log a message with an Info tag.
   * @param {...*} msg message data to write
   */
  static info() {
    console.info(...arguments);
    Log.messages.push([Log.Info, arguments]);
    Log.onMessage.emit(Log.Info, arguments);
  }

  /**
   * Log a message with an Debug tag.
   * @param {...*} msg message data to write
   */
  static debug() {
    console.debug(...arguments);
    Log.messages.push([Log.Debug, arguments]);
    Log.onMessage.emit(Log.Debug, arguments);
  }

  /**
   * Log a message with an Error tag.
   * @param {...*} msg message data to write
   */
  static error() {
    console.error(...arguments);
    Log.messages.push([Log.Error, arguments]);
    Log.onMessage.emit(Log.Error, arguments);
  }

  /**
   * Log a message with an Warning tag.
   * @param {...*} msg message data to write
   */
  static warning() {
    console.warn(...arguments);
    Log.messages.push([Log.Warning, arguments]);
    Log.onMessage.emit(Log.Warning, arguments);
  }

  /**
   * Present an Alert modal dialog with the given message
   * @param {...*} msg message data to write
   */
  static alert() {
    window.alert(...arguments);
  }

  /**
   * Convert message data, either a string or anything that JSON can stringify, to a string.
   * @param {*} args message data to convert
   * @return {String}
   */
  static messageToString(args) {
    if (args.constructor === String) return args;

    let s = '';
    for (const i in args) {
      const arg = args[i];
      if (!arg) continue;
      if (arg.constructor === String) s += `${arg} `;
      else s += JSON.stringify(arg) + ' ';
    }
    return s;
  }

  /**
   * If condition is false, log the message and present an alert message.
   * @param {bool} condition
   * @param {String} text
   */
  static assert(condition, text) {
    if (condition === false) {
      console.error('ASSERT:', text);
      Log.alert(text);
      Log.messages.push([Log.Assert, text]);
      Log.onMessage.emit(Log.Assert, text);
    }
  }

  /**
   * Print error code and emit an event so it can be traced.
   * @param {String} error
   * @param {number} line
   * @param {String} resource
   * @param {*} [extra]
   */
  static codeError(error, line, resource, extra) {
    const errorInfo = {
      error: error,
      line: line,
      resource: resource,
      extra: extra,
    };
    console.error(errorInfo);
    Log.messages.push([Log.CodeError, errorInfo]);
    Log.onMessage.emit(Log.CodeError, errorInfo);
    Log.onCodeError.emit(errorInfo);
  }

  /**
   * Clear the logged messages.
   */
  static clear() {
    Log.messages.length = 0;
    Log.onClear.emit();
  }
}

Log.Message = 0;
Log.Info = 1;
Log.Debug = 2;
Log.Error = 3;
Log.Warning = 4;
Log.Alert = 5;
Log.Assert = 6;
Log.CodeError = 7;

/**
 * @property {Signal} onMessage Emitted when a message has been logged.
 */
Log.onMessage = new Signal();
/**
 * @property {Signal} onCodeError Emitted when a code error message has been logged.
 */
Log.onCodeError = new Signal();
/**
 * @property {Signal} onClear Called when the log has been cleared.
 */
Log.onClear = new Signal();
/**
 * @property {Array} messages The list of messages that have been logged.
 */
Log.messages = [];
