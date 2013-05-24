var Imd = require('awssum-amazon-imd').Imd;

module.exports = function getRegion(cb) {
    var imd = new Imd();

    // credit: http://stackoverflow.com/a/9263531/445792
    imd.Get({
        Version: 'latest',
        Category: '/dynamic/instance-identity/document'
    }, function (err, data) {
        if (err) return cb(err);
        return cb(null, JSON.parse(data.Body).region);
    });
};

