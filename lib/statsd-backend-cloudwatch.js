const getRegion = require('./get-region'), 
      getIamCreds = require('./get-iam-creds'),
      CloudWatch = require("awssum-amazon-cloudwatch").CloudWatch
      AUTO = "__AUTO";

/*
 * The CloudWatch API allows for up to 40KB for an HTTP POST to put 
 * stats into CloudWatch. To be safe we are limiting to a specific number 
 * of metrics MAX_METRICS_PER_REQUEST. 
 *
 * ref: http://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_PutMetricData.html
 */
const MAX_METRICS_PER_REQUEST = 12;

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


    var enableDebug = !!config.cloudwatch.debug || false;

    if (config.cloudwatch.region == AUTO) {
        console.log("Fetching region from meta-data");
        getRegion(function(err, instanceRegion) {
            if (err) {
                console.error('ERROR: Region Fetch Error: ', err)
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
        // CloudWatch only handles at most, 1 minute of data granularity. 
        //
        // So this *should* be ok to fetch on each flush
        if (config.cloudwatch.creds == "IAM") {
            getIamCreds(function(err, creds) {
                if (err) {
                    console.error("ERROR: (IAM) ", err);
                    return; 
                }

                var iamCreds = {
                    accessKeyId     : creds.accessKeyId,
                    secretAccessKey : creds.secretAccessKey,
                    token           : creds.token,
                    region          : region
                };

                self.flush(iamCreds, config.cloudwatch.namespace, timestamp, metrics);
            });
        } else {
            var cwCreds = {
                accessKeyId     : config.cloudwatch.creds.accessKeyId,
                secretAccessKey : config.cloudwatch.creds.secretAccessKey,
                token           : config.cloudwatch.creds.token,
                region          : region
            };

            self.flush(cwCreds, config.cloudwatch.namespace, timestamp, metrics, enableDebug);
        }
    });
}

CloudWatchBackend.prototype.flush = function(creds, namespace, timestamp, metrics, enableDebug) {

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
     */
    function queueData(data) {

        if (!!data == false) return;

        if (!(data.Namespace in cwPackets)) {
            cwPackets[data.Namespace] = [{ "Namespace": data.Namespace, "MetricData": [] }];
        }

        last_packet = cwPackets[data.Namespace].slice(-1)[0];
        for (var i = 0; i < data.MetricData.length; i++) {
            // too big? start a new one
            if (last_packet["MetricData"].length >= MAX_METRICS_PER_REQUEST) {
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
    for (key in timers) {
        if (timers[key].length > 0) {
            var values = timers[key].sort(function (a,b) { return a-b; });
            var count = values.length;
            var min = values[0];
            var max = values[count - 1];

            var cumulativeValues = [min];
            for (var i = 1; i < count; i++) {
                cumulativeValues.push(values[i] + cumulativeValues[i-1]);
            }

            var sum = min;
            var mean = min;
            var maxAtThreshold = max;

            var message = "";

            var key2;

            sum = cumulativeValues[count-1];
            mean = sum / count;
            
            md = prepareMetric(key, namespace, {
                MetricData : [{
                    Unit : 'Milliseconds',
                    Timestamp: new Date(timestamp*1000).toISOString(),
                    StatisticValues: {
                        Minimum: min,
                        Maximum: max,
                        Sum: sum,
                        SampleCount: count
                    }
                }]
            });

            queueData(md);
        }
    }

    // gauges
    for (key in gauges) {
        md = prepareMetric(key, namespace, {
            MetricData : [{
                Unit : 'None',
                Timestamp: new Date(timestamp*1000).toISOString(),
                Value : gauges[key]
            }]
        });
        queueData(md);
    }

    // sets
    for (key in sets) {
        md = prepareMetric(key, namespace, {
            MetricData : [{
                Unit : 'None',
                Timestamp: new Date(timestamp*1000).toISOString(),
                Value : sets[key].values().length
            }]
        });
        queueData(md);
    }

    if (enableDebug === true) {
        console.log("********************************");
        console.log("CLOUDWATCH BACKEND DEBUG ENABLED");
        console.log("********************************");
        console.log(JSON.stringify(cwPackets, null, '    '));
        return;
    }

    for (ns in cwPackets) {
        for (var i = 0; i < cwPackets[ns].length; i++) {
            // ref: http://awssum.io/amazon/cloudwatch/put-metric-data.html
            cloudwatch.PutMetricData(
                cwPackets[ns][i],
                function(err, data) {
                    if (err) {
                        console.error("ERROR", err);
                        return;
                    } else {
                        console.log("CW OK", JSON.stringify(data));
                    }
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

/*******************************************************************************
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
 *******************************************************************************

{ counters:
   { 'statsd.bad_lines_seen': 0,
     'statsd.packets_received': 129,
     'counter.c0': 24,
     'counter.c1': 24,
     'counter.c2': 24 },
  timers:
   { 'timer.c0': [ 245, 281, 291 ],
     'timer.c1': [ 211, 221, 241 ],
     'timer.c2': [ 274, 283, 333 ] },
  gauges:
   { 'gauge.c0': 9679.032836575061,
     'gauge.c1': 1994.1638479940593,
     'gauge.c2': 5099.610802717507 },
  timer_data:
   { 'timer.c0':
      { mean_90: 272.3333333333333,
        upper_90: 291,
        sum_90: 817,
        std: 19.754043186705402,
        upper: 291,
        lower: 245,
        count: 3,
        count_ps: 1.2,
        sum: 817,
        mean: 272.3333333333333 },
     'timer.c1':
      { mean_90: 224.33333333333334,
        upper_90: 241,
        sum_90: 673,
        std: 12.472191289246473,
        upper: 241,
        lower: 211,
        count: 3,
        count_ps: 1.2,
        sum: 673,
        mean: 224.33333333333334 },
     'timer.c2':
      { mean_90: 296.6666666666667,
        upper_90: 333,
        sum_90: 890,
        std: 25.952948879762307,
        upper: 333,
        lower: 274,
        count: 3,
        count_ps: 1.2,
        sum: 890,
        mean: 296.6666666666667 } },
  counter_rates:
   { 'statsd.bad_lines_seen': 0,
     'statsd.packets_received': 51.6,
     'counter.c0': 9.6,
     'counter.c1': 9.6,
     'counter.c2': 9.6 },
  sets:
   { 'set.c0': [ '4', '8', '29', '32', '36', '38', '40', '41', '50', '66', '69', '91', '97' ],
     'set.c1': [ '5', '16', '17', '22', '30', '31', '50', '52', '56', '63', '65', '76', '86' ],
     'set.c2': [ '7', '25', '26', '37', '40', '72', '80', '82', '83', '88', '93', '99' ] },
  pctThreshold: [ 90 ] }


******************************************************************************************
Object created by this backend before it is sent to CloudWatch

- this is what `cwPackets` looks like before it is sent to CloudWatch.
- there is a key for each namespace
- each key is an `array`, with blobs of Metric data. Each element in this array
  is sent as a `putMetricData` HTTP request to CloudWatch
******************************************************************************************

{
    "MyService": [
        {
            "Namespace": "MyService",
            "MetricData": [
                {
                    "Unit": "Count",
                    "Timestamp": "2013-05-27T17:52:44.000Z",
                    "Value": 24,
                    "MetricName": "counter.c0"
                },
                {
                    "Unit": "Count",
                    "Timestamp": "2013-05-27T17:52:44.000Z",
                    "Value": 24,
                    "MetricName": "counter.c1"
                },
                {
                    "Unit": "Count",
                    "Timestamp": "2013-05-27T17:52:44.000Z",
                    "Value": 24,
                    "MetricName": "counter.c2"
                },
                {
                    "Unit": "Milliseconds",
                    "Timestamp": "2013-05-27T17:52:44.000Z",
                    "StatisticValues": {
                        "Minimum": 245,
                        "Maximum": 291,
                        "Sum": 817,
                        "SampleCount": 3
                    },
                    "MetricName": "timer.c0"
                },
                {
                    "Unit": "Milliseconds",
                    "Timestamp": "2013-05-27T17:52:44.000Z",
                    "StatisticValues": {
                        "Minimum": 211,
                        "Maximum": 241,
                        "Sum": 673,
                        "SampleCount": 3
                    },
                    "MetricName": "timer.c1"
                },
                {
                    "Unit": "Milliseconds",
                    "Timestamp": "2013-05-27T17:52:44.000Z",
                    "StatisticValues": {
                        "Minimum": 274,
                        "Maximum": 333,
                        "Sum": 890,
                        "SampleCount": 3
                    },
                    "MetricName": "timer.c2"
                },
                {
                    "Unit": "None",
                    "Timestamp": "2013-05-27T17:52:44.000Z",
                    "Value": 9679.032836575061,
                    "MetricName": "gauge.c0"
                },
                {
                    "Unit": "None",
                    "Timestamp": "2013-05-27T17:52:44.000Z",
                    "Value": 1994.1638479940593,
                    "MetricName": "gauge.c1"
                },
                {
                    "Unit": "None",
                    "Timestamp": "2013-05-27T17:52:44.000Z",
                    "Value": 5099.610802717507,
                    "MetricName": "gauge.c2"
                },
                {
                    "Unit": "None",
                    "Timestamp": "2013-05-27T17:52:44.000Z",
                    "Value": 13,
                    "MetricName": "set.c0"
                },
                {
                    "Unit": "None",
                    "Timestamp": "2013-05-27T17:52:44.000Z",
                    "Value": 13,
                    "MetricName": "set.c1"
                },
                {
                    "Unit": "None",
                    "Timestamp": "2013-05-27T17:52:44.000Z",
                    "Value": 12,
                    "MetricName": "set.c2"
                }
            ]
        }
    ]
}
*/
