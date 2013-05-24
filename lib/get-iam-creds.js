
var Imd = require('awssum-amazon-imd').Imd;

module.exports = function getIamCreds(cb) {
    var imd = new Imd();

    imd.Get({
        Version: 'latest',
        Category: '/meta-data/iam/security-credentials/'
    }, function (err, data) {
        if (err) return cb(err);

        var role = data.Body;

        imd.Get({
            Version: 'latest',
            Category: '/meta-data/iam/security-credentials/' + role
        }, function (err, data) {
            if (err) return cb(err);

            var creds = JSON.parse(data.Body);

            creds.extra = {
                TTL: (Date.parse(creds.Expiration) - Date.now())
            };

            cb(null, creds);
        });
    });
};

