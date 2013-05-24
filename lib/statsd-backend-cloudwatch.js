const getRegion = require('./get-region'), 
      getIamCreds = require('./get-iam-creds'),
      CloudWatch = require("awssum-amazon-cloudwatch").CloudWatch;
    


function CloudWatchBackend(startupTime, config, emitter) {

    var self = this;
    var creds = false; // starting value... we got some async stuff later
    var region = false;

    // sanity checks
    if (!("cloudwatch" in config)) {
        throw new Error("No cloudwatch config");
    }

    ["namespace", "region", "creds"].forEach(function(key) {
        if (!(key in config.cloudwatch)) {
            throw new Error("Missing CloudWatch Config: " + key)
        }

        if (key == "creds") {
            if (config.cloudwatch.creds != "IAM") {
                ["accessKeyId", "secretAccessKey"].foreach(function(k) {
                    if (!(key in config.cloudwatch.creds)) {
                        throw new Error("Missing credential: creds."+k);
                    }
                });
            }
        }
    });

    if (config.creds == "IAM") {

        var timeout = 0;

        function updateCredsFromIAM() {
            console.log("Fetching IAM Credentials");

            getIamCreds(function(err, creds) {
                if (err) {
                    console.error("IAM ERROR: ", err);
                    return; 
                }

                creds.accessKeyId     = creds.accessKeyId;
                creds.secretAccessKey = creds.secretAccessKey;
                creds.token           = creds.token;

                // auto-update the credentials when they expire
                var max_time = 5 * 60 * 1000; 
                if (creds.expires >= max_time) {
                    console.log("Refreshing IAM Credentials in " + max_time + "ms");
                    timeout = setTimeout(updateCredsFromIAM, max_time)
                } else {
                    console.log("Refreshing IAM Credentials in " + creds.expires + "ms");
                    timeout = setTimeout(updateCredsFromIAM, creds.expires)
                }
            });
        };

        updateCredsFromIAM();
    } else {
        creds = config.creds;
    }

    if (config.region == "__AUTO") {
        console.log("Fetching region from meta-data");
        getRegion(function(err, instanceRegion) {
            if (err) {
                console.log('Region Fetch Error: ', err)
                return;
            }

            region = instanceRegion;
        });
    } else {
        region = config.region;
    }

    emitter.on("flush", function(timestamp, metrics) {
        self.flush(creds, config.namespace, timestamp, metrics);
    });
}


CloudWatchBackend.prototype.flush = function(creds, namespace, timestamp, metrics) {

}

exports.init = function(startupTime, config, emitter) {
    try {
        var instance = new CloudwatchBackend(startupTime, config, emitter);
    } catch (err) {
        console.error(err);
        return false;
    }
    return true;
};

