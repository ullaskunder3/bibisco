/*
 * Copyright (C) 2014-2022 Andrea Feccomandi
 *
 * Licensed under the terms of GNU GPL License;
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.gnu.org/licenses/gpl-3.0.en.html
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY.
 * See the GNU General Public License for more details.
 *
 */
'use strict';
const electron = require('electron');
const app = electron.app;
const ipc = electron.ipcMain;
const Menu = electron.Menu;
const MenuItem = electron.MenuItem;
const SpellChecker = require('simple-spellchecker');
const fs = require('fs-extra');
const path = require('path');

// prevent window being garbage collected
let mainWindow;

// closing semaphore
let closing = false;

// development or production?
const isDev = require('electron-is-dev');

// add winston logger
const logger = initLogger(isDev);
ipc.on('logger-debug', function (event, arg) {
  logger.debug(arg);
});
ipc.on('logger-info', function (event, arg) {
  logger.info(arg);
});
ipc.on('logger-error', function (event, arg) {
  logger.error(arg);
});

// init temp directory
initTempDirectory();

// init bibisco dictionaries directory
initBibiscoDictionariesDirectory();

// electron version
logger.info('*** Electron version: ' + process.versions.electron);

// add debug features like hotkeys for triggering dev tools and reload
if (isDev) {
  logger.debug('Running in development -  global path:' + __dirname);
  require('electron-debug')();
} else {
  logger.debug('Running in production -  global path:' + __dirname);
}
logger.debug('User home preferences: '+app.getPath('userData'));

// zipper/unzipper
var zip;
ipc.on('zipFolder', function (event, arg) {
  getZip().zipFolder(arg.folderToZip, arg.zippedFilePath, function () {
    mainWindow.webContents.send('master-process-callback', { callbackId: arg.callbackId });
  });
});
ipc.on('unzip', function (event, arg) {
  getZip().unzip(arg.zippedFilePath, arg.destinationFolder, function() {
    mainWindow.webContents.send('master-process-callback', { callbackId: arg.callbackId });
  });
});

// context info
ipc.on('getcontextinfo', function (event) {
  let contextInfo = {
    os: process.platform,
    appPath: __dirname,
    userDataPath: app.getPath('userData')
  };
  event.returnValue = contextInfo;
});

// dictionary
let myDictionary = null;
let myDictionaryLanguage = null;
let myDictionaryProject = null;

// load dictionary
ipc.on('loadDictionary', function(event, language) {

  // check if dictionary is already loaded
  if (myDictionaryLanguage && myDictionaryLanguage === language) {
    logger.info('Dictionary ' + language + ' already loaded.');
    mainWindow.webContents.send('DICTIONARY_LOADED', language);
    return;
  }

  // check if dictionary is not unpacked
  if (!isDictionaryUnpacked(language)) {
    unpackDictionary(language, function() {
      loadDictionary(language);
    });
    
    return;
  }

  // load dictionary
  loadDictionary(language);
});

// set dictionary
ipc.on('loadProjectDictionary', function(event, projectDictionary, projectId) {
  loadProjectDictionary(projectDictionary, projectId);
});

// consult the dictionary
ipc.on('isMisspelled', function(event, word) {
  var result = null;
  if(myDictionary !== null && word !== null) {
    word = word.replace(/’/g, '\''); 
    result = myDictionary.isMisspelled(word);
    if (result) {
      result = !isNumeric(word);
    }
  }
  event.returnValue = result;
});

// unpack the dictionary.
ipc.on('unpackAndLoadDictionary', function(event, language) {
  unpackDictionary(language, function() {
    loadDictionary(language);
  });
});

// context menu string table
let contextMenuStringTable = null;

// set context menu string table
ipc.on('setContextMenuStringTable', function(event, stringTable) {
  contextMenuStringTable = stringTable;
});

ipc.on('closeApp', function(event) {
  logger.info('bibisco is closing...');
  closing = true;
  app.quit();
});

ipc.on('isFullScreenEnabled', function (event) {
  event.returnValue = mainWindow.isFullScreen();
});

ipc.on('enableFullScreen', function(event) {
  mainWindow.setFullScreen(true);
});

ipc.on('exitFullScreen', function(event) {
  mainWindow.setFullScreen(false);
});


// add dialog
const {
  dialog
} = require('electron');
const { unzip } = require('zlib');
const { Logger } = require('winston');

ipc.on('selectdirectory', function (event, arg) {
  dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory']
  }).then(function (result) {
    if (!result.canceled) {
      let params = [];
      params.push({directory: result.filePaths[0]});
      mainWindow.webContents.send('master-process-callback', 
        { 
          callbackId: arg.callbackId,
          params: params
        });
    }
  }).catch(err => {
    logger.error(err);
  });
});

ipc.on('selectfile', function (event, arg) {
  let filters;
  if (!arg.filefilter) {
    filters = [];
  } else {
    filters = [{
      name: 'filters',
      extensions: arg.filefilter
    }];
  }
  dialog.showOpenDialog({
    filters: filters,
    properties: ['openFile']
  }).then(function (result) {
    if (result.filePaths[0]) {
      let params = [];
      params.push({ file: result.filePaths[0] });
      mainWindow.webContents.send('master-process-callback',
        {
          callbackId: arg.callbackId,
          params: params
        });
    }
  });
});


function createMainWindow() {
  let icon = undefined;
  if (process.platform === 'linux') {
    icon = `${__dirname}/assets/icons/linux/bibisco-circle-hr.png`;
  } else if (process.platform === 'darwin') {
    icon = `${__dirname}/assets/icons/mac/icon.icns`;
  } else if (process.platform === 'win32') {
    icon = `${__dirname}/assets/icons/win/bibisco_circle_hr_MYa_icon.ico`;
  }
  const win = new electron.BrowserWindow({
    width: 1024,
    height: 620,
    minWidth: 1024,
    minHeight: 620,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nativeWindowOpen: true,
      nodeIntegration: true,
      spellcheck: false,
      worldSafeExecuteJavaScript: false
    }
  });

  win.loadURL(`file://${__dirname}/index.html`, {
    'extraHeaders': 'pragma: no-cache\n'
  });
  win.once('ready-to-show', () => {
    win.show();
  });
  
  win.on('close', function(e) {
    if (!closing) {
      e.preventDefault();
      mainWindow.webContents.send('APP_CLOSING');
      logger.debug('The user wants to close bibisco...');
    }
  });

  win.on('closed', function(e) {
    // dereference the window
    // for multiple windows store them in an array
    mainWindow = null;
  });

  // context menu
  win.webContents.on('context-menu', (event, menuInfo) => {

    // show context menu only on content editable
    if (menuInfo.isEditable && menuInfo.inputFieldType === 'none') {
      const menu = new Menu();

      // suggestions
      if (menuInfo.misspelledWord) {
        let isMisspelledWordFirstLetterUppercase = isFirstLetterUppercase(menuInfo.misspelledWord);
        let suggestions = myDictionary.getSuggestions(menuInfo.misspelledWord);
        if (suggestions && suggestions.length > 0) {
          suggestions.forEach((suggestion) => {
            suggestion = isMisspelledWordFirstLetterUppercase ? capitalizeFirstLetter(suggestion) : suggestion;
            let item = new MenuItem({
              label: suggestion,
              click: function() {
                win.webContents.replaceMisspelling(suggestion);
                win.webContents.send('REPLACE_MISSPELLING');
              } 
            });
            menu.append(item);
          });

          // separator
          menu.append(new MenuItem({
            type: 'separator'
          }));
        }
      }

      // add to dictionary
      if (menuInfo.misspelledWord) {
        menu.append(
          new MenuItem({
            label: contextMenuStringTable ? contextMenuStringTable.addToDictionary : 'Add to dictionary',
            click: function() {
              let word = menuInfo.selectionText;
              myDictionary.addRegex(new RegExp('^' + word + '$'));
              win.webContents.send('ADD_WORD_TO_PROJECT_DICTIONARY', word);
            }
          })
        );
      }

      // cut
      menu.append(new MenuItem({
        label: contextMenuStringTable ? contextMenuStringTable.cut : 'Cut',
        accelerator: 'CommandOrControl+X',
        enabled: menuInfo.editFlags.canCut,
        click: () => win.webContents.cut()
      }));

      // copy
      menu.append(new MenuItem({
        label: contextMenuStringTable ? contextMenuStringTable.copy : 'Copy',
        accelerator: 'CommandOrControl+C',
        enabled: menuInfo.editFlags.canCopy,
        click: () => win.webContents.copy()
      }));

      // paste
      menu.append(new MenuItem({
        label: contextMenuStringTable ? contextMenuStringTable.paste : 'Paste',
        accelerator: 'CommandOrControl+V',
        enabled: menuInfo.editFlags.canPaste,
        click: () => win.webContents.paste()
      }));

      // show menu
      menu.popup();
    }
  });

  return win;
}

app.on('window-all-closed', function() {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', function() {
  if (!mainWindow) {
    mainWindow = createMainWindow();
  }
});

app.on('ready', function() {
  mainWindow = createMainWindow();
  if (process.platform === 'darwin') {
    let menuTemplate;
    menuTemplate = [{
      label: 'bibisco',
      submenu: [{
        role: 'hide'
      }, {
        role: 'hideothers'
      }, {
        role: 'unhide'
      }, {
        type: 'separator'
      }, {
        role: 'undo'
      }, {
        role: 'redo'
      }, {
        type: 'separator'
      }, {
        role: 'cut'
      }, {
        role: 'copy'
      }, {
        role: 'paste'
      }, {
        role: 'delete'
      }, {
        role: 'selectall'
      }, {
        type: 'separator'
      }, {
        role: 'quit'
      }]
    }];
    const electronMenu = electron.Menu;
    const applicationMenu = electronMenu.buildFromTemplate(menuTemplate);
    electronMenu.setApplicationMenu(applicationMenu);
  } else {
    mainWindow.removeMenu();
  }
});

function initLogger(isDev) {
  let loggerDirectory = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(loggerDirectory)) {
    fs.mkdirSync(loggerDirectory);
  }
  let loggerFilePath = path.join(loggerDirectory, 'bibisco.log');
  const logger = require('winston');
  logger.level = (isDev ? 'debug' : 'info');
  logger.add(logger.transports.File, {
    filename: loggerFilePath,
    json: false,
    maxsize: 1000000,
    maxFiles: 2,
    handleExceptions: true,
    humanReadableUnhandledException: true,
    formatter: function(options) {
      var dateFormat = require('dateformat');
      // Return string will be passed to logger.
      return dateFormat(new Date(), 'yyyy-mm-dd HH:MM:ss:l') + ' ' +
        options.level
          .toUpperCase() + ' ' + (options.message ? options.message : '') +
        (options.meta && Object.keys(options.meta).length ? '\n\t' + JSON
          .stringify(
            options.meta) : '');
    }
  });

  return logger;
}

function initTempDirectory() {
  let tempDirectory = path.join(app.getPath('userData'), 'temp');
  if (!fs.existsSync(tempDirectory)) {
    fs.mkdirSync(tempDirectory);
  }
}

function initBibiscoDictionariesDirectory() {
  let bibiscoDictionariesDirectory = path.join(app.getPath('userData'), 'bibiscoDictionaries');
  if (!fs.existsSync(bibiscoDictionariesDirectory)) {
    fs.mkdirSync(bibiscoDictionariesDirectory);
  }
}

function getZip() {
  if (!zip) {
    zip = initZip();
  }

  return zip;
}

function initZip() {
  let yazl = require('yazl');
  let yauzl = require('yauzl');
  let walkSync = require('walk-sync');

  return {
    zipFolder: function(folderToZip, zippedFilePath, callback) {
      logger.debug('Remote zipFolder start: ' + folderToZip);

      let zipfile = new yazl.ZipFile();
      let fileList = walkSync(folderToZip, {
        directories: false,
        globs: ['**/!(*.DS_Store)']
      });
      for (let i = 0; i < fileList.length; i++) {
        logger.debug('Processing ' + fileList[i]);
        zipfile.addFile(folderToZip + '/' + fileList[i],
          path.basename(folderToZip) + '/' +
          fileList[i]);
      }
      // call end() after all the files have been added
      zipfile.end();

      // pipe() can be called any time after the constructor
      zipfile.outputStream.pipe(fs.createWriteStream(zippedFilePath)).on(
        'close',
        function() {
          logger.info(zippedFilePath + ' done!');
          callback();
        });

      logger.debug('Remote zipFolder end');

    },
    unzip: function(zippedFilePath, destinationFolder, callback) {
      logger.debug('Remote unzip start: ' + zippedFilePath);
      yauzl.open(zippedFilePath, {
        lazyEntries: true
      }, function(err, zipfile) {
        // From documentation: https://github.com/thejoshwolfe/yauzl
        // The callback is given the arguments (err, zipfile).
        // An err is provided if the End of Central Directory Record cannot be
        // found, or if its metadata appears malformed. This kind of error
        // usually indicates that this is not a zip file.
        if (err) throw err;

        zipfile.readEntry();
        zipfile.on('close', function() {
          logger.debug('End extracting ' + zippedFilePath);
          callback();
        });
        zipfile.on('entry', function(entry) {
          logger.debug('Processing ' + entry.fileName);
          if (/\/$/.test(entry.fileName)) {
            // directory file names end with '/'
            fs.mkdirp(path.join(destinationFolder, entry.fileName),
              function(
                err) {
                if (err) throw err;
                zipfile.readEntry();
              });
          } else {
            // file entry
            zipfile.openReadStream(entry, function(err, readStream) {
              if (err) throw err;
              // ensure parent directory exists
              fs.mkdirp(path.join(destinationFolder, path.dirname(
                entry.fileName)),
              function(err) {
                if (err) throw err;
                readStream.pipe(fs.createWriteStream(path.join(
                  destinationFolder, entry.fileName)));
                readStream.on('end', function() {
                  zipfile.readEntry();
                });
              });
            });
          }
        });
      });
    }
  };
}

function getDictionaryDirectory() {
  return path.join(app.getPath('userData'), 'bibiscoDictionaries');
}

function loadDictionary(language) {
  let start = Date.now();
  SpellChecker.getDictionary(language, getDictionaryDirectory(), function(err, result) {
    if(!err) {
      myDictionary = result;
      myDictionaryLanguage = language;
      logger.info('Loaded ' + language + ' dictionary! in ' + ((Date.now() - start))/1000) + ' seconds';
      mainWindow.webContents.send('DICTIONARY_LOADED', language);
    } else {
      logger.error('Error loading ' + language + ' dictionary: ' + err);
    }
  });
}

function loadProjectDictionary(projectDictionary, projectId) {
 
  if (projectId === myDictionaryProject) {
    logger.debug('Project ' + projectId + ' dictionary already loaded');
  }

  else if (myDictionary) {
    myDictionary.clearRegexs();
  
    if (projectDictionary && projectDictionary.length>0) {
      for (let index = 0; index < projectDictionary.length; index++) {
        let word = projectDictionary[index];
        myDictionary.addRegex(new RegExp('^' + word + '$'));
      }
    }
    
    myDictionaryProject = projectId;
    logger.info('loaded project ' + projectId + ' dictionary: ' + (projectDictionary ? JSON.stringify(projectDictionary) : '[]'));
  }

  mainWindow.webContents.send('PROJECT_DICTIONARY_LOADED', projectId);
}

function isDictionaryUnpacked(language) {

  let dicFilePath = path.join(getDictionaryDirectory(), language + '.dic');  
  let result = fs.existsSync(dicFilePath);
  logger.info('Is dictionary ' + language + ' unpacked? ' + result);
  return result;
}

function unpackDictionary(language, callback) {
    
  // unzip dictionary file
  unzipDictionaryFile(language, function() {
         
    // read bibidic
    readBibidicFile(language, function(compressedWords) {

      // decompress dictionary words
      let decompressedWords = getDecompressedWords(compressedWords);

      // write dic file
      writeDicfile(language, decompressedWords, function() {

        // delete bibidic file
        deleteBibidicFile(language, function() {

          if (callback) {
            callback();
          }
        });
      });
    });
  });
}

function unzipDictionaryFile(language , callback) {
  let zippedFilePath = path.join(__dirname, path.join('dictionaries', language + '.zip'));
  getZip().unzip(zippedFilePath, getDictionaryDirectory(), function() {
    logger.info('Unzipped ' + zippedFilePath);
    if (callback) {
      callback();
    }
  });
}

function readBibidicFile(language, callback) {
  let bibidicFilePath = path.join(getDictionaryDirectory(), language + '.bibidic');
  let start = Date.now();
  fs.readFile(bibidicFilePath, 'utf8', function(err,text) {
    let compressedWords;
    if (text) {
      compressedWords = text.split('\n');
    }
    logger.info('Read ' + bibidicFilePath + ' ('+  compressedWords.length + ' words) in ' + ((Date.now() - start))/1000) + ' seconds';
     
    if (callback) {
      callback(compressedWords);
    }
  });
}

function getDecompressedWords(compressedWords){
  let start = Date.now();
  let result;
  const reg = /\d+/;
  let prevWord = '';
  result = compressedWords.map( word => {
    if (word[0] === '|') {
      return word.substr(1, word.length);
    }

    const result = word.match(reg);
    let newWord = '';
    if (result === null){
      newWord = prevWord + word;
    } else {
      newWord = prevWord.substr(0, parseInt(result[0])) + word.substr(result[0].length);
    }
    prevWord = newWord;
    
    return newWord;
  });
  logger.info('Decompress ' + compressedWords.length + ' words in ' + ((Date.now() - start))/1000) + ' seconds';
  return result;
}

function writeDicfile(language, decompressedWords, callback) {
  let dicFilePath = path.join(getDictionaryDirectory(), language + '.dic');
  let start = Date.now();
  let newContent = '';  
  let first = true;
  for(let i=0; i<decompressedWords.length; i++) {          
    if(decompressedWords[i] !== '' && decompressedWords[i] !== '\n') {
      if(!first) newContent += '\n';
      newContent += decompressedWords[i];
      first = false;
    }
  }
  
  // Write dic file.
  fs.writeFile(dicFilePath, newContent, 'utf8', function(err) {
    if (err) {
      logger.error(dicFilePath + ' could not be writted: ' + err);
    } else {
      logger.info('Written ' + dicFilePath + ' in ' + ((Date.now() - start))/1000) + ' seconds';
      if (callback) {
        callback();
      }
    }
  });

}

function deleteBibidicFile(language, callback) {

  let bibidicFilePath = path.join(getDictionaryDirectory(), language + '.bibidic');
  fs.unlink(bibidicFilePath, function(err) {
    if (err) {
      logger.error(bibidicFilePath + ' could not be deleted: ' + err);
    } else {
      logger.info('Deleted ' + bibidicFilePath);
      if (callback) {
        callback();
      }
    }
  });
}

function isFirstLetterUppercase(word) {
  return word[0] === word[0].toUpperCase();
}

function capitalizeFirstLetter(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function isNumeric(word) {
  if (typeof word !== 'string') return false; // we only process strings!  
  word = word.replace(/,/g, '.'); // replace comma with period, for float in not US locale
  word = word.replace(/:/g, '.'); // replace colon with period, for hours
  return !isNaN(word) && // use type coercion to parse the _entirety_ of the string (`parseFloat` alone does not do this)...
         !isNaN(parseFloat(word)); // ...and ensure strings of whitespace fail
}