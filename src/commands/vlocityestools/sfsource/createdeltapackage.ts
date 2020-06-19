import { flags, SfdxCommand } from "@salesforce/command";
import { Messages } from "@salesforce/core";
import { AppUtils } from "../../../utils/AppUtils";

// Initialize Messages with the current plugin directory
Messages.importMessagesDirectory(__dirname);

// Load the specific messages for this file. Messages from @salesforce/command, @salesforce/core,
// or any library that is using the messages framework can also be loaded this way.
const messages = Messages.loadMessages("vlocityestools", "deltapackage");

export default class deltaPackage extends SfdxCommand {
  public static description = messages.getMessage("commandDescription");

  public static examples = [
    `$ sfdx vlocityestools:sfsource:createdeltapackage -u myOrg@example.com -p cmt -d force-app
  `,
    `$ sfdx vlocityestools:sfsource:createdeltapackage --targetusername myOrg@example.com --package ins --sourcefolder force-app
  `,
    `$ sfdx vlocityestools:sfsource:createdeltapackage --targetusername myOrg@example.com --package ins --sourcefolder force-app --gitcheckkey EPC
  `,
    `$ sfdx vlocityestools:sfsource:createdeltapackage --targetusername myOrg@example.com --sourcefolder force-app --gitcheckkeycustom VBTDeployKey --customsettingobject DevOpsSettings__c
  `
  ];

  public static args = [{ name: "file" }];

  protected static flagsConfig = {
    package: flags.string({char: "p", description: messages.getMessage("packageType")}),
    sourcefolder: flags.string({ char: "d", description: messages.getMessage("sourcefolder")}),
    gitcheckkey: flags.string({ char: "k", description: messages.getMessage("gitcheckkey")}),
    gitcheckkeycustom: flags.string({ char: "v", description: messages.getMessage("gitcheckkeycustom")}),
    customsettingobject: flags.string({ char: "c", description: messages.getMessage("customsettingobject")})
  };

  protected static requiresUsername = true;

  public async run() {
    const fsExtra = require("fs-extra");
    const path = require('path');

    AppUtils.logInitial(messages.getMessage("command"));

    var packageType = this.flags.package;
    var sourceFolder = this.flags.sourcefolder;
    var deployKey = "VBTDeployKey";
    var gitcheckkeycustom = this.flags.gitcheckkeycustom;
    var customsettingobject = this.flags.customsettingobject;

    if(customsettingobject != undefined && gitcheckkeycustom == undefined) {
      throw new Error("Error: -v, --gitcheckkeycustom needs to passed when using customsettingobject");
    }

    if(gitcheckkeycustom != undefined && customsettingobject == undefined) {
      throw new Error("Error: -c, --customsettingobject needs to passed when using gitcheckkeycustom");
    }

    //console.log("this.flags.gitcheckkey: " + this.flags.gitcheckkey);

    if(this.flags.gitcheckkey != undefined) {
      deployKey = deployKey + this.flags.gitcheckkey;
    }
    //console.log("deployKey: " + deployKey);
    
    var deltaPackageFolder = sourceFolder + '_delta';

    if (customsettingobject == undefined) {
      if (packageType == "cmt") {
        AppUtils.namespace = "vlocity_cmt__";
      } else if (packageType == "ins") {
        AppUtils.namespace = "vlocity_ins__";
      } else {
        throw new Error("Error: -p, --package has to be either cmt or ins ");
      }
    }

    const conn = this.org.getConnection();

    var query;

    if(customsettingobject != undefined) {
      query = "SELECT Name, Value__c FROM " + customsettingobject + " WHERE Name = '" + gitcheckkeycustom + "'";
    }
    else {
      const initialQuery = "SELECT Name, %name-space%Value__c FROM %name-space%GeneralSettings__c WHERE Name = '" + deployKey + "'";
      query = AppUtils.replaceaNameSpace(initialQuery);
    }

    //console.log("query: " + query);
    const result = await conn.query(query);
    const repoPath = path.normalize("./");
    const simpleGit = require("simple-git")(repoPath);
    if (result.records.length < 1) {
      AppUtils.log2("Hash not found in the environment, Coping full Package");
      deltaPackage.copyCompleteFolder(sourceFolder, deltaPackageFolder, fsExtra);
    } else if (!simpleGit.checkIsRepo()) {
      throw new Error("Error: Current directory is not a repository");
    } else {
      var previousHash;
      if(customsettingobject != undefined) {
        previousHash = result.records[0][AppUtils.replaceaNameSpace("Value__c")];
      }
      else {
        previousHash = result.records[0][AppUtils.replaceaNameSpace("%name-space%Value__c")];
      }
      if( previousHash == undefined || previousHash == null ){
        throw new Error("Custom Setting record found but Hash is empty.. Nothing was copied  ");
      }
      else {
        AppUtils.log2("Hash found in the environment: " + previousHash);
        if (fsExtra.existsSync(deltaPackageFolder)) {
          AppUtils.log2("Old delta folder was found... deleting before creating new delta: " + deltaPackageFolder );
          fsExtra.removeSync(deltaPackageFolder);
        }
        deltaPackage.doDelta(simpleGit, sourceFolder, deltaPackageFolder, fsExtra, previousHash,path);
      }
    }    
  }

  static copyCompleteFolder(sourceFolder, deltaPackageFolder, fsExtra) {
    if (fsExtra.existsSync(deltaPackageFolder)) {
      fsExtra.removeSync(deltaPackageFolder);
    }
    fsExtra.mkdirSync(deltaPackageFolder);
    fsExtra.copySync(sourceFolder, deltaPackageFolder);
  }
  static doDelta(simpleGit, sourceFolder, deltaPackageFolder, fsExtra, previousHash,path) {
    simpleGit.diffSummary([previousHash], (err, status) => {
      if (err) {
        throw new Error( "Error with GitDiff, Nothing was copied - Error: " + err );
        //deltaPackage.copyCompleteFolder( sourceFolder, deltaPackageFolder, fsExtra);
      } else {
        var numOfDiffs = status.files.length;
        if (numOfDiffs > 0) {
          AppUtils.log2("Creating delta Folder: " + deltaPackageFolder);
          AppUtils.log2("Deltas: ");
          status.files.forEach(files => {
            //console.log('File: ' + files.file);
            var filePath = files.file;
            if (fsExtra.existsSync(filePath) && filePath.includes(sourceFolder)) {
              var newfilePath = filePath.replace(sourceFolder,deltaPackageFolder);
              AppUtils.log2("Delta File: " + filePath); //+ ' /////// newfilePath: ' + newfilePath);
              if (filePath.includes(path.sep + "aura" + path.sep) || filePath.includes(path.sep + "lwc" + path.sep) || filePath.includes(path.sep + "experiences" + path.sep)) {
                var splitResult = filePath.split(path.sep);
                var compFileName = splitResult[splitResult.length-1];
                var CompPath = filePath.substring(0, filePath.length - compFileName.length);
                var newCompPath = CompPath.replace(sourceFolder, deltaPackageFolder);
                //console.log('CompPath: ' + CompPath + ' /////// newCompPath: ' + newCompPath);
                if (fsExtra.existsSync(newCompPath) == false) {
                  AppUtils.log1("Moving complete folder for changed file. New path: " + newCompPath);
                  fsExtra.copySync(CompPath, newCompPath);
                  if (filePath.includes(path.sep + "experiences" + path.sep)) {
                    var CompPathXML = CompPath + ".site-meta.xml";
                    var newCompPathXML = newCompPath + ".site-meta.xml";
                    if (fsExtra.existsSync(CompPathXML)) {
                      AppUtils.log1("Moving Meta File for folder. New path: " + newCompPathXML);
                      fsExtra.copySync(CompPathXML, newCompPathXML);
                    }
                  }
                }
                else {
                  AppUtils.log1("MetaData alredy moved: " + newCompPath);
                }
              } else {
                if(filePath.includes("-meta.xml") && !filePath.includes("staticresources") ) {
                  var nonMetaFilePath = filePath.substring(0, filePath.length - 9);
                  var nonMetaFileNewfilePath = newfilePath.substring(0, newfilePath.length - 9);
                  if (fsExtra.existsSync(nonMetaFilePath)) {
                    AppUtils.log1("Moving changed file. New path: " + nonMetaFileNewfilePath);
                    fsExtra.copySync(nonMetaFilePath, nonMetaFileNewfilePath);
                  }
                } 
        
                AppUtils.log1("Moving changed file. New path: " + newfilePath);
                fsExtra.copySync(filePath, newfilePath);

                var metaXMLFile = filePath + "-meta.xml";
                if (fsExtra.existsSync(metaXMLFile)) {
                  var newMetaXMLFile = newfilePath + "-meta.xml";
                  AppUtils.log1("Moving changed file. New path: " + newMetaXMLFile);
                  fsExtra.copySync(metaXMLFile, newMetaXMLFile);
                }

                if(filePath.includes("staticresources")) {
                  var splitResultSR = filePath.split(path.sep);
                  var staticResourceMetaFile = splitResultSR[0] + path.sep + splitResultSR[1] + path.sep + splitResultSR[2] + path.sep + splitResultSR[3] + path.sep + splitResultSR[4] + ".resource-meta.xml";
                  var newStaticResourceMetaFile = staticResourceMetaFile.replace(sourceFolder, deltaPackageFolder);
                  //console.log("////// CompPath: " + newStaticResourceMetaFile);
                  if (fsExtra.existsSync(staticResourceMetaFile)) {
                    AppUtils.log1("Moving changed file. New path: " + newStaticResourceMetaFile);
                    fsExtra.copySync(staticResourceMetaFile, newStaticResourceMetaFile);
                  }

                } 
              }
            }
          });
        } else {
          AppUtils.log2("No Diffs Found");
        }
      }
    });
  }
}
