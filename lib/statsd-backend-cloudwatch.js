const getRegion = require('./get-region'), 
      getIamCreds = require('./get-iam-creds'),
      CloudWatch = require("awssum-amazon-cloudwatch").CloudWatch
      AUTO = "__AUTO";

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
                ["accessKeyId", "secretAccessKey"].forEach(function(k) {
                    if (!(k in config.cloudwatch.creds)) {
                        throw new Error("Missing credential: creds."+k);
                    }
                });
            }
        }
    });

    if (config.region == AUTO) {
        console.log("Fetching region from meta-data");
        getRegion(function(err, instanceRegion) {
            if (err) {
                console.log('Region Fetch Error: ', err)
                return;
            }

            region = instanceRegion;
        });
    } else {
        region = config.cloudwatch.region;
    }

    emitter.on("flush", function(timestamp, metrics) {

        if (region === false) {
            console.error("ERROR: No region set... async race condition?");
            return;
        }

        // TODO, we fetch the creds each time we flush. StatsD should 
        // only be flushing stats to CloudWatch at intervals > 30s. 
        // CloudWatch only handles at most, 1minute of data granularity. 
        //
        // So this *should* be ok to fetch on each flush
        if (config.creds == "IAM") {
            getIamCreds(function(err, creds) {
                if (err) {
                    console.error("IAM ERROR: ", err);
                    return; 
                }

                var iamCreds = {
                    accessKeyId     : creds.accessKeyId,
                    secretAccessKey : creds.secretAccessKey,
                    token           : creds.token,
                    region          : region
                };

                self.flush(iamCreds, config.namespace, timestamp, metrics);
            });
        } else {
            var cwCreds = {
                accessKeyId     : config.cloudwatch.creds.accessKeyId,
                secretAccessKey : config.cloudwatch.creds.secretAccessKey,
                token           : config.cloudwatch.creds.token,
                region          : region
            };

            self.flush(cwCreds, config.cloudwatch.namespace, timestamp, metrics);
        }
    });
}

CloudWatchBackend.prototype.flush = function(creds, namespace, timestamp, metrics) {

    var cloudwatch = new CloudWatch(creds);

    // reference below for what `metrics` looks like
    var counters = metrics.counters;
    var gauges   = metrics.gauges;
    var timers   = metrics.timers;
    var sets     = metrics.sets;
    
    // gather together all the metrics into a single request
    var cwPackets = {};

    /**
     * Group together multiple, related metrics into a single CloudWatch PUT request. 
     * A bit of juggling has to be done here around request limits, but basically
     * each PUT request can puts up to 8 metrics. If there are more than 8 metrics
     * we split things up into multiple requests.
     *
     */
    function queueData(data) {

        if (!!data == false) return;

        if (!(data.Namespace in cwPackets)) {
            cwPackets[data.Namespace] = [{ "Namespace": data.Namespace, "MetricData": [] }];
        }

        last_packet = cwPackets[data.Namespace].slice(-1)[0];
        for (var i = 0; i < data.MetricData.length; i++) {
            // too big? start a new one
            if (last_packet["MetricData"].length >= 8) {
                last_packet = { "Namespace": data.Namespace, "MetricData": [] };
                cwPackets[data.Namespace].push(last_packet);
            }
            last_packet.MetricData.push(data.MetricData[i]);
        }
    }

    /*
     * a bit of indirection to handle automatic namespacing/metric naming from 
     * the StatsD bucket name
     */
    function prepareMetric(key, namespace, data) {
        if (namespace == AUTO) {
            var parts = key.split('.');
            if (parts.length < 2) {
                console.error("ERROR: auto namespace and invalid key: " + key);
                return null;
            }

            namespace = parts.shift();
            key = parts.join('.');
        }

        data.Namespace = namespace;
        data.MetricData.forEach(function(md) {
            md.MetricName = key;
        });
        
        return data;
    }

    for (key in counters) {
        if (key.indexOf('statsd.') == 0)
            continue;

        md = prepareMetric(key, namespace, {
            MetricData : [{
                Unit : 'Count',
                Timestamp: new Date(timestamp*1000).toISOString(),
                Value : counters[key]
            }]
        });

        queueData(md);
    }

    // timers
    // gauges
    // sets

    /* DEBUG */
    console.log(JSON.stringify(cwPackets, null, '    '));
    return;

    for (ns in cwPackets) {
        // TODO, this could fire off a heck of a lot of concurrent requests...
        // let's see if it needs some rate limiting
        for (var i = 0; i < cwPackets[ns].length; i++) {
            cloudwatch.PutMetricData(
                cwPackets[ns][i],
                function(err, data) {
                    fmt.dump(err, 'Err');
                    fmt.dump(data, 'Data');
                }
            );
        }
    }
}


exports.init = function(startupTime, config, emitter) {
    try {
        var instance = new CloudWatchBackend(startupTime, config, emitter);
    } catch (err) {
        console.error(err);
        return false;
    }
    return true;
};

/* 
 * Reference Info: 
 *
 * This is what `metrics` looks like from StatsD
 *
 * There are 4 sections: 
 *
 *  - counters/counter_data
 *  - timers/timer_data
 *  - guages
 *  - sets
 *
 ***
    { counters:
       { 'statsd.bad_lines_seen': 0,
         'statsd.packets_received': 96,
         'Moz.IDP.boom': 25,
         'MyStat2.stat2': 25,
         'stat3.something': 25 },
      counter_rates:
       { 'statsd.bad_lines_seen': 0,
         'statsd.packets_received': 38.4,
    
         'Moz.IDP.boom': 10,
         'MyStat2.stat2': 10,
         'stat3.something': 10 },
    
      timers: { 'fetch.lag': [ 225, 267, 297 ] },
      timer_data:
       { 'fetch.lag':
          { mean_90: 263,
            upper_90: 297,
            sum_90: 789,
            std: 29.5296461204668,
            upper: 297,
            lower: 225,
            count: 3,
            count_ps: 1.2,
            sum: 789,
            mean: 263 } },
    
      gauges: { g1: 7514.287156518549, g2: 7673.471076413989 },
    
      sets:
       { set1:
          [ '21', '90', '100'  ... more unique values ] 
       },
      pctThreshold: [ 90 ] 
    }
*/
