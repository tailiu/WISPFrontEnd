var server = require('http').createServer(handleRequest)
var io = require('socket.io')(server)
var fs = require('fs')
var qs = require('querystring')
var ejs = require('ejs')
var r = require('rethinkdb')
var async = require('async')
var _ = require('underscore')
var childProcess = require('child_process')
var crypto = require('crypto')

//Configuration file path
const configFilePath = './configuration'

//Database host and port
const dbPort = 28015
const dbHost = 'localhost'

//Exmaple folder paths
const exampleFolder = 'examples/'

var examples = []

var cachedResults = {}

//Fixed port server listens to
var serverAddr 
var serverPort

//Algorithm File paths
var dummyNetworkPath 
var minCostFlowPath
var minCostFlowPlusPath
var cplexPath

//Add script tags
function preprocessBundle(str) {
    return '<script>' + str + '</script>'
}

//Dynamic data
function preprocessVar(obj) {
    return '<script> data = ' + JSON.stringify(obj) + '</script>'
}

//Get the boundary marker coordinates from the database
function getBoundaryCoordinates(callback) {
    r.connect({ host: dbHost, port: dbPort }, function(err, conn) {
        if(err) throw err

        r.db('networkPlanningTool').table('boundary').without('id').run(conn, function(err, cursor) {
            if (err) throw err
            
            cursor.toArray(function(err, result) {
                if (err) throw err

                callback(err, result)
            })
        })
    })
}

function logErr(req, err, errMsg) {
    var clientAddr
    if (req.headers['x-forwarded-for'] == undefined) {
        clientAddr = req.connection.remoteAddress
    } else {
        clientAddr = req.headers['x-forwarded-for']
    }
    var time = new Date()
    if (errMsg == undefined) {
        errMsg = null
    }
    console.error('Request from ' + clientAddr + ' at ' + time + ' causes errors:')
    console.error(errMsg)
    console.error(err)
}

//Handle the Homapage
function handleHomePage(req, res) {
	fs.readFile('bundlejs/index.js', function(err, bundlejs) {
        if (err) {
            logErr(req, err)
            return
        }

        getBoundaryCoordinates(function(err, boundary){
            if (err) {
                logErr(req, err)
                return
            }

            //Render the index.ejs file with bundled script file
            var data = {}
            var processedData = {}
            processedData.boundary = boundary
            processedData.serverPort = serverPort
            processedData.serverAddr = serverAddr
            processedData.examples = examples

            data.bundlejs = preprocessBundle(bundlejs)
            data.variable = preprocessVar(processedData)

            ejs.renderFile('index.html', data, null, function(err, str){
                if (err) {
                    logErr(req, err)
                    return
                } 

                res.end(str)
            })
        })
    })
}

//Handle other pages
function handleReferencedFile(req, res) {
    var fileName = req.url.slice(1)

    fs.readFile(fileName, function(err, data) {
        if (err) {
            res.end('File Not Found!!')
        }
        res.end(data)
    })
}

//Transform one coordinate to one pixel, using rethinkdb k-Nearest Neighbors algorithm
function getOnePixelByOneCoordinate(coordinate, pixels, callback) {
    r.connect({ host: dbHost, port: dbPort }, function(err, conn) {
        if(err) throw err

        var markerCooridinate = r.point(coordinate.lng, coordinate.lat);

        r.db('networkPlanningTool').table('geo').getNearest(markerCooridinate, {index: 'location', maxResults: 1}).run(conn, function(err, nearestPoint) {
            
            pixels.push(nearestPoint[0].doc.pixel)

            callback(null, pixels)
        })
    })
}

function getOneCoordinateByOnePixel(pixel, coordinates, callback) {
    r.connect({ host: dbHost, port: dbPort }, function(err, conn) {
        if(err) {
            callback(err, null)
            return
        }

        r.db('networkPlanningTool').table('geo').filter({

            pixel: pixel

            }).run(conn, function(err, cursor){
                cursor.toArray(function(err, result) {
                if(err) {
                    callback(err, null)
                    return
                }

                var coordinate = result[0].location.coordinates
                var coordinateObj = {}
                coordinateObj.lng = coordinate[0]
                coordinateObj.lat = coordinate[1]

                coordinates.push(coordinateObj)

                callback(null, coordinates) 
            })
        })
    })
}

function getCoordinatesByPixels(pixels, callback) {
    var length = pixels.length
    var coordinates = []

    async.whilst(
        function () { return length > 0 },

        function (callback) {
            --length
            getOneCoordinateByOnePixel(pixels[length], coordinates, callback)
        },

        function (err, coordinateArr) {
            callback(err, coordinateArr)
        }
    )
}

function getPixelsByCoordinates(coordinates, callback) {
    var length = coordinates.length
    var pixels = []

    async.whilst(
        function () { return length > 0 },

        function (callback) {
            --length
            getOnePixelByOneCoordinate(coordinates[length], pixels, callback)
        },

        function (err, pixelArr) {
            callback(pixelArr)
        }
    )
}

function extractCoordinatesFromNodes(nodes, callback) {
    var coordinatesArr = []

    for (var i in nodes) {
        coordinatesArr.push(nodes[i].node)
    }

    callback(coordinatesArr)
}

function insertPixelsToNodes(pixelsArr, nodes, callback) {
    var length = nodes.length

    for (var i in pixelsArr) {
        nodes[length - 1 - i].node = pixelsArr[i]
    }

    callback()
}

function transformCoordinatesToPixels(nodes, callback) {
    async.waterfall([
        function(callback) {
            extractCoordinatesFromNodes(nodes, function(coordinatesArr){
                callback(null, coordinatesArr)
            })
        },
        function(coordinatesArr, callback) {
            getPixelsByCoordinates(coordinatesArr, function(pixelsArr) {
                callback(null, pixelsArr)
            })
        },
        function(pixelsArr, callback) {
            insertPixelsToNodes(pixelsArr, nodes, function(){
                callback(null)
            })
        }
    ], function (err, result) {
        callback()
    })
}

function dummyNetwork(input, callback) {
    console.log('**************** Input ******************')
    console.log(JSON.stringify(input))
    console.log('**********************************')
    console.log()

    childProcess.execFile('python', [dummyNetworkPath, JSON.stringify(input)], function(error, output, stderr){
        if (error) {
            throw error
        }
        
        console.log('**************** Output ******************')
        console.log(output)
        console.log('**********************************')

        callback(error, JSON.parse(output))
    })
}

function minCostFlow(input, callback) {
    console.log('**************** Input ******************')
    console.log(JSON.stringify(input))
    console.log('**********************************')
    console.log()

    childProcess.execFile(minCostFlowPath, [JSON.stringify(input)], function(error, output, stderr){
        if (error) {
            throw error
        }
        
        console.log('**************** Output ******************')
        console.log(output)
        console.log('**********************************')

        callback(error, JSON.parse(output))
    })
}

function minCostFlowPlus(input, callback) {
    console.log('**************** Input ******************')
    console.log(JSON.stringify(input))
    console.log('**********************************')
    console.log()

    childProcess.execFile(minCostFlowPlusPath, [JSON.stringify(input)], function(error, output, stderr){
        if (error) {
            throw error
        }
        
        console.log('**************** Output ******************')
        console.log(output)
        console.log('**********************************')

        callback(error, JSON.parse(output))
    })
}

function cplex(input, callback) {
    console.log('**************** Input ******************')
    console.log(JSON.stringify(input))
    console.log('**********************************')
    console.log()

    childProcess.execFile(cplexPath, [JSON.stringify(input)], function(error, output, stderr){
        if (error) {
            throw error
        }
        
        console.log('**************** Output ******************')
        console.log(output)
        console.log('**********************************')

        callback(error, JSON.parse(output))
    })
}

function callAlgorithm(algorithm, input, callback) {
    switch(algorithm) {
        case 'Dummy Network': 
            dummyNetwork(input, callback)
            break

        case 'Min Cost Flow':
            minCostFlow(input, callback)
            break

        case 'Min Cost Flow ++':
            minCostFlowPlus(input, callback)
            break

        case 'CPLEX Network Optimizer':
            cplex(input, callback)
            break
    }
}

function collectPixelsFromOutput(output) {
    var pixels = []
    var nodes = output.nodes

    for (var i in nodes) {
        pixels.push(nodes[i].node)
    }

    return pixels
}

function replacePixelsWithCoordinates(output, coordinates) {
    var nodes = output.nodes
    var edges = output.edges
    var index = coordinates.length - 1

    for (var i in nodes) {
        var pixel = nodes[i].node

        for (var j in edges) {
            if (edges[j].nodes[0] == pixel) {
                edges[j].nodes[0] = coordinates[index - i]
            }
            if (edges[j].nodes[1] == pixel) {
                edges[j].nodes[1] = coordinates[index - i]
            }
        }

        nodes[i].node = coordinates[index - i]

    }
}

function transformPixelsToCoordinates(output, callback) {
    var pixels = collectPixelsFromOutput(output)

    getCoordinatesByPixels(pixels, function(err, coordinates) {
        if (err) {
            callback(err, null)
            return
        }
        
        try {
            replacePixelsWithCoordinates(output, coordinates)
        } catch (err) {
            callback(err, null)
            return
        }

        callback(null, output)
    })
}

function packageAlgorithmInput(data, pixels) {
    data.coordinates = {}
    data.coordinates.providers = pixels[0]
    data.coordinates.newUsers = pixels[1]

    return data   
}

function addIndexToNodeProperty(output) {
    var nodes = output.nodes

    for (var i in nodes) {
        nodes[i].nodeProperty.id = nodes[i].node
    }
}

function packageOutputAndSendRes(req, res, rawData, output) {
    fs.readFile('bundlejs/plannedNetwork.js', function(err, bundlejs) {
        if (err) {
            logErr(req, err)
            return
        }

        //Get boundary coordinates from the database
        getBoundaryCoordinates(function(err, boundary) {
            if (err) {
                logErr(req, err)
                return
            }

            var processedData = {}
            processedData.serverAddr = serverAddr
            processedData.serverPort = serverPort
            processedData.result = output
            processedData.input = rawData
            processedData.boundary = boundary
            
            //Render the index.ejs file with bundled script file
            var data = {}

            data.bundlejs = preprocessBundle(bundlejs)
            data.variable = preprocessVar(processedData)

            ejs.renderFile('index.html', data, null, function(err, str){
                if (err) {
                    logErr(req, err)
                    return
                }

                res.end(str)
            })
        })
    })
}

//Handle network planning request
function handleNetworkPlanRequest(req, res) {
    var body = ''

    req.on('data', function(rawData){
        body += rawData
    })

    req.on('end', function() {
        var rawData = qs.parse(body)
        var nodes = JSON.parse(rawData.nodes)
        
        var algorithm = rawData.algorithm
                
        transformCoordinatesToPixels(nodes, function(err){
            rawData.nodes = nodes

            var index = createHash(JSON.stringify(rawData))
            var cached = cachedResults[index]
            delete rawData['algorithm']

            if (cached != undefined) {
                packageOutputAndSendRes(req, res, rawData, cached)
            } else {
                async.waterfall([
                    function(callback) {
                        callAlgorithm(algorithm, rawData, callback)
                    },
                    function(output, callback) {
                        processAlgorithmOutput(output, algorithm, callback)
                    }
                ], function (err, output) {
                    if (err) {
                        logErr(req, err)
                        return
                    }

                    cachedResults[index] = output

                    packageOutputAndSendRes(req, res, rawData, output)
                })
            }
            
        })      
    })
}

//Handle unknown requests
function handleDefault(req, res) {
    res.end('Page Not Found!')
}

//This function handles requests and send a response
function handleRequest(req, res) {
	var path = req.url

    switch(path) {
    	case '/':
    		handleHomePage(req, res)
    		break

        case '/mapjs/index.js':
        case '/mapjs/plannedNetwork.js':
        case '/styles/css/index.css':
        case '/styles/images/provider.png':
        case '/styles/images/newUser.png':
        case '/styles/images/boundary.jpg':
        case '/styles/images/source.png':
        case '/styles/images/sink.png':
        case '/styles/images/intermediate.png':
        case '/styles/images/pruned.png':
            handleReferencedFile(req, res)
            break

        case '/submitNetworkRawData':
            handleNetworkPlanRequest(req, res)
            break

    	default:
    		handleDefault(req, res)
    }    
}

function addAlgorithmToOutput(output, algorithm) {
    output.algorithm = algorithm
}

function processAlgorithmOutput(output, algorithm, callback) {
    try {
        addAlgorithmToOutput(output, algorithm)
        addIndexToNodeProperty(output)
    } catch (err) {
        callback(err)
        return
    }

    transformPixelsToCoordinates(output, callback)
}

function sendErrRes(socket, errMsg) {
    output = {}
    output.errMsg = errMsg
    socket.emit('getResults', output)
}

function getExamples() {
    var files = fs.readdirSync(exampleFolder)
    for (var i in files) {
        var filePath = exampleFolder + files[i]
        examples.push(JSON.parse(fs.readFileSync(filePath).toString()))
    }
}

function createHash(dataToHash) {
    var hash = crypto.createHash('sha1')
    hash.update(dataToHash)
    return hash.digest('hex')
}

//First, read Configuration file
fs.readFile(configFilePath, function (err, data) {
    var configData = JSON.parse(data.toString())
    serverAddr = configData.serverAddr
    serverPort = configData.serverPort
    dummyNetworkPath = configData.dummyNetworkPath
    minCostFlowPath = configData.minCostFlowPath
    minCostFlowPlusPath = configData.minCostFlowPlusPath
    cplexPath = configData.cplexPath

    //Read examples
    getExamples()

    //Then, start the server
    server.listen(serverPort, function(){
        console.log('Server is listening on port: %d', serverPort)
    })

    //Initialize web socket
    io.on('connection', function (socket) {
        socket.on('callAlgorithm', function(args) {
            switch (args.algorithm) {
                case 'Input JSON Data Directly':
                    try {
                        var data = JSON.parse(args.input)
                    }
                    catch (err) {
                        var errMsg = 'Error: Invalid JSON data'
                        logErr(socket.request, err, errMsg)
                        sendErrRes(socket, errMsg)
                        return
                    }
                    processAlgorithmOutput(data, args.algorithm, function(err, output) {
                        if (err) {
                            var errMsg = 'Error: Invalid JSON data'
                            logErr(socket.request, err, errMsg)
                            sendErrRes(socket, errMsg)
                            return
                        }
                        socket.emit('getResults', output)
                    })
                    break

                case 'Clear the Cache of the Current Results':
                    var output = {
                        'algorithm': args.algorithm
                    }
                    args.algorithm = args.currentAlgorithm
                    delete args.currentAlgorithm
                    var index = createHash(JSON.stringify(args))
                    delete cachedResults[index]
                    socket.emit('getResults', output)
                    break

                default:
                    var index = createHash(JSON.stringify(args))
                    var cached = cachedResults[index]
                    if (cached != undefined) {
                        socket.emit('getResults', cached)
                        return
                    }

                    var algorithm = args.algorithm
                    delete args[algorithm]
                    async.waterfall([
                        function(callback) {
                            callAlgorithm(algorithm, args, callback)
                        },
                        function(output, callback) {
                            processAlgorithmOutput(output, algorithm, callback)
                        }
                    ], function (err, output) {
                        if (err) {
                            logErr(socket.request, err)
                            return
                        }

                        cachedResults[index] = output

                        socket.emit('getResults', output)
                    })
            }
        })
    })
})
