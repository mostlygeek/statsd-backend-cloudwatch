statsd-backend-cloudwatch
=========================

This is a backend for StatsD that sends stats into AWS CloudWatch. 

# Configuration

The backend takes a very simple configuration. Here are all the 
available configuration options: 

    {
        backends: [ "statsd-backend-cloudwatch" ],
        cloudwatch: {
            namespace : "MyService",
            region    : "AWS_REGION",
            creds     : {
                accessKeyId: "Access Key", 
                secretAccessKey: "secret"
            },

            debug: false
        }
    }

EC2 IAM roles are supported. This will automatically fetch a temporary access key, secret and token 
from the EC2 metadata. Just make sure your IAM role has a security policy to put information 
into CloudWatch. 

Set `creds` to `IAM` for credentials to be automatically pulled from the EC2 instance's meta data.

    {
        backends: [ "statsd-backend-cloudwatch" ],
        cloudwatch: {
            namespace : "MyService",
            region    : "AWS_REGION",
            creds     : "IAM"
        }
    }

Detection of the region is also possible. If you want all StatsD data
to go to CloudWatch in the same region change `region` to `__AUTO`.

    {
        backends: [ "statsd-backend-cloudwatch" ],
        cloudwatch: {
            namespace : "MyService",
            region    : "__AUTO",
            creds     : "IAM"
        }
    }

Finally, the CloudWatch namespace can be automatically extracted
from the StatsD bucket name.

    {
        backends: [ "statsd-backend-cloudwatch" ],
        cloudwatch: {
            namespace : "__AUTO",
            region    : "__AUTO",
            creds     : "IAM"
        }
    }

*NOTE*: use this feature with caution. The way this feature works is 
bucket names will be split on a `.` character. If a bucket name does not 
have at least two parts it will be *skipped*. 

Example of what will happen to buckets names:

    Bucket Name                 NameSpace       Metric Name
    ------------                ---------       -----------
    MyCounter                           *skipped*
    MyApp.MyCounter             MyApp           MyCounter
    MyApp.counters.requests     MyApp           counters.requests
    MyApp.counters.failures     MyApp           counters.failures
    MyApp/MyCounter.ok                  *skipped*

## Debug Mode

The `debug` flag will 

* output the cloudwatch data (what goes into the awssum API) to the console
* stills sends it to CloudWatch

