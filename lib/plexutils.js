var Q = require('q');
var app = require('./app.js');
var utils = require('./utils.js');
var util = require('util');

/**
 * Get the list of online servers
 * @returns {Promise.array.object} An array of online servers, as returned by the plex API
 */
var getServers = function() {
    return app.plex.web.query('/api/resources?includeHttps=1').then(function(resources) {
        return resources.MediaContainer.Device.filter(function(resource){
            return (resource.attributes.provides.search(/server/i) != -1 &&
            resource.attributes.presence == '1');
        });
    });
};

/**
 * Get the list of players available to a Plex Media Server for playback
 * @returns {Promise.array.object} An array of online clients capable of playback, as returned by the plex API
 */
var getPlayers = function() {
    return app.plex.pms.query('/clients').then(function(resources) {
        return resources._children.filter(function(resource){
            return (resource.protocolCapabilities.search(/playback/i) != -1);
        });
    });
};

/**
 * Get a list of items that are "On Deck"
 * @returns {Object} JSON object of shows/movies/etc on desk
 */
var getOnDeck = function() {
    return app.plex.pms.query('/library/onDeck');
};

var startShow = function(options, response) {
    if(!options.spokenShowName) {
        return Q.reject(new Error('startShow must be provided with a spokenShowName option'));
    }
    if(!options.playerName) {
        return Q.reject(new Error('startShow must be provided with a playerName option'));
    }

    var playerName = options.playerName;
    var spokenShowName = options.spokenShowName;
    var forceRandom = options.forceRandom || false;
    var onlyTopRated = options.onlyTopRated || null;
    var episodeNumber = options.episodeNumber || null;
    var seasonNumber = options.seasonNumber || null;

    var responseSpeech;
    var matchConfidence;

    return getListOfTVShows().then(function(listOfTVShows) {
        var bestShowMatch = getShowFromSpokenName(spokenShowName, listOfTVShows._children);
        var show = bestShowMatch.bestMatch;
        matchConfidence = bestShowMatch.confidence;

        if (!show) {
            // Show name not found
            console.warn("Show requested not found: " + spokenShowName);
            response.say("Sorry, I couldn't find that show in your library");
            return Q.resolve();
        }

        return getAllEpisodesOfShow(show).then(function (allEpisodes) {
            var episode;
            var viewOffset = 0;

            if(episodeNumber || seasonNumber) {
                // The user specififed a specific episode

                if(!seasonNumber && episodeNumber > 100) {
                    // Allow episode notation of "203" to mean s02e03
                    seasonNumber = Math.floor(episodeNumber / 100);
                    episodeNumber = episodeNumber % 100;
                } else if (!seasonNumber) {
                    seasonNumber = 1;
                }

                var seasonEpisodes = allEpisodes._children.filter(function(ep) {return ep.parentIndex==seasonNumber;});
                if(seasonEpisodes.length === 0) {
                    response.say("I'm sorry, there does not appear to be a season " + seasonNumber + " of " + show.title);
                    return Q.resolve();
                }
                episode = seasonEpisodes.filter(function(ep) {return ep.index==episodeNumber})[0];

                if(!episode) {
                    response.say("I'm sorry, there does not appear to be an episode " + episodeNumber + ", season " + seasonNumber + " of " + show.title);
                    return Q.resolve();
                } else {
                    responseSpeech = "Alright, here is <say-as interpret-as='digits'>s" + seasonNumber + "e" + episodeNumber + "</say-as> of " + show.title + ": " + episode.title;
                }
            } else if(!forceRandom) {
                episode = getFirstUnwatched(allEpisodes._children);

                if(episode) {
                    if(episode.viewOffset > 0) {
                        viewOffset = episode.viewOffset;
                        responseSpeech = "Continuing the next episode of " + show.title + " from where you left off: " + episode.title;
                    } else {
                        responseSpeech = "Enjoy the next episode of " + show.title + ": " + episode.title;
                    }

                }
            }

            if(!episode) {
                // First check to see if there's a partially-watched episode in this show
                episode = findEpisodeWithOffset(allEpisodes._children, onlyTopRated);

                if(episode) {
                    // If there is an episode that is partially-watched, ask the user if they'd like to resume that one,
                    // otherwise they'll get a random episode.
                    var randomEpisode = getRandomEpisode(allEpisodes._children, onlyTopRated);
                    console.log('confidence: ' , matchConfidence);
                    response.session('promptData', {
                        yesAction  : 'startEpisode',
                        yesResponse: "Resuming this episode from Season " + episode.parentIndex + ": " + episode.title,
                        mediaKey   : episode.key,
                        mediaOffset : episode.viewOffset,
                        playerName : playerName,
                        noResponse : "Alright, then enjoy this episode from Season " + randomEpisode.parentIndex + ": " + randomEpisode.title,
                        noAction   : 'startEpisode',
                        noMediaKey : randomEpisode.key,
                        noMediaOffset : 0
                    });
                    response.shouldEndSession(false);
                    return response.say("It looks like you're part-way through the episode" + episode.title + ". Would you like to resume that one?");
                }

                episode = getRandomEpisode(allEpisodes._children, onlyTopRated);
                responseSpeech = "Enjoy this episode from Season " + episode.parentIndex + ": " + episode.title;
            }

            response.card('Plex', 'Playing ' + show.title + ': ' + episode.title, 'Playing Episode');

            if (matchConfidence >= app.CONFIDICE_CONFIRM_THRESHOLD) {
                response.say(responseSpeech);
                return playMedia({
                    playerName: playerName,
                    mediaKey: episode.key,
                    offset: viewOffset
                });
            } else {
                console.log('confidence: ' , matchConfidence);
                response.session('promptData', {
                    yesAction  : 'startEpisode',
                    yesResponse: responseSpeech,
                    noResponse : 'Oh. Sorry about that.',
                    noAction   : 'endSession',
                    mediaKey   : episode.key,
                    mediaOffset : viewOffset,
                });
                response.shouldEndSession(false);
                return response.say('You would like to watch an episode of ' + episode.grandparentTitle + '. Is that correct?');
            }
        });
    }).catch(function(err) {
        console.error("Error thrown in promise chain");
        console.error(err);
        response.say("I'm sorry, Plex and I don't seem to be getting along right now");
        return Q.reject(err);
    });
};

var getListOfTVShows = function() {
    return app.plex.pms.query('/library/sections/1/all');
};

var getAllEpisodesOfShow = function(show) {
    if(typeof show === 'object') {
        show = show.ratingKey;
    }
    return app.plex.pms.query('/library/metadata/' + show + '/allLeaves');
};

var playMedia = function(parameters) {
    var mediaKey = parameters.mediaKey;
    var playerName = parameters.playerName;
    var offset = parameters.offset || 0;

    // We need the server machineIdentifier for the final playMedia request
    return getMachineIdentifier().then(function(serverMachineIdentifier) {
        // Get the Client's IP, which can also be provided as an env var to skip an API call
        return getClientIP(playerName).then(function(clientIP) {
            var keyURI = encodeURIComponent(mediaKey);
            // Yes, there is a double-nested URI encode here. Wacky Plex API!
            var libraryURI = encodeURIComponent('library://' + app.plex.pms.getIdentifier() + '/item/' + keyURI);

            // To play something on a client, we need to add it to a new "Play Queue"
            return app.plex.pms.postQuery('/playQueues?type=video&includechapters=1&uri='+libraryURI+'&shuffle=0&continuous=1&repeat=0').then(function(result) {
                var playQueueID = result.playQueueID;
                var containerKeyURI=encodeURIComponent('/playQueues/' + playQueueID + '?own=1&window=200');

                var playMediaURI = '/system/players/'+clientIP+'/playback/playMedia' +
                    '?key=' + keyURI +
                    '&offset=' + offset +
                    '&machineIdentifier=' + serverMachineIdentifier +
                        //'&address=' + process.env.PMS_HOSTNAME + // Address and port aren't needed. Leaving here in case that changes...
                        //'&port=' + process.env.PMS_PORT +
                    '&protocol=http' +
                    '&containerKey=' + containerKeyURI +
                    '&commandID=2' + // TODO this is supposed to be an incrementing number on each request
                    '';
                console.log(playMediaURI);

                return app.plex.pms.perform(playMediaURI);
            });
        });
    });
};

var getMachineIdentifier = function() {
    if (process.env.PMS_IDENTIFIER) {
        return Q.resolve(process.env.PMS_IDENTIFIER);
    } else {
        return app.plex.pms.query('/').then(function (res) {
            process.env.PMS_IDENTIFIER = res.machineIdentifier;
            return Q.resolve(process.env.PMS_IDENTIFIER);
        });
    }
};

var getClientIP = function(clientname) {
    if(process.env.PLEXPLAYER_IP) {
        return Q.resolve(process.env.PLEXPLAYER_IP);
    } else {
        return app.plex.pms.find("/clients", {name: clientname}).then(function (clients) {
            var clientMatch;

            if (Array.isArray(clients)) {
                clientMatch = clients[0];
            }

            return Q.resolve(clientMatch.address);
        });
    }
};

var filterEpisodesByExists = function(episodes) {
    return episodes.filter(function(item, i) {
        return (!item.deletedAt)
    });
};

var filterEpisodesByBestRated = function(episodes, topPercent) {
    episodes.sort(function(a, b) {
        if(a.rating && b.rating)
            return a.rating - b.rating; // Shorthand for sort compare
        if(a.rating) {
            return 1;
        }
        if(b.rating) {
            return -1;
        }
        return 0;
    }).reverse();

    episodes = episodes.filter(function(item, i) {
        return i / episodes.length <= topPercent;
    });

    return episodes;
};

var findEpisodeWithOffset = function(episodes, onlyTopRated) {
    episodes = filterEpisodesByExists(episodes);
    if (onlyTopRated) {
        episodes = filterEpisodesByBestRated(episodes, onlyTopRated);
    }

    var episodesWithOffset = episodes.filter(function(item, i) {
        return item.viewOffset > 0;
    });

    return episodesWithOffset[0];
};

var getRandomEpisode = function(episodes, onlyTopRated) {
    episodes = filterEpisodesByExists(episodes);
    if (onlyTopRated) {
        episodes = filterEpisodesByBestRated(episodes, onlyTopRated);
    }

    return episodes[utils.randomInt(0, episodes.length - 1)];
};

var getFirstUnwatched = function(episodes) {
    var firstepisode;

    for (i = 0; i < episodes.length; i++) {
        if ('viewCount' in episodes[i]) {
            continue;
        }

        if (firstepisode === undefined) {
            firstepisode = episodes[i];
        } else if (!('viewCount' in episodes[i])
            && episodes[i].parentIndex < firstepisode.parentIndex
            || (episodes[i].parentIndex == firstepisode.parentIndex
            && episodes[i].index < firstepisode.index)
        ){
            firstepisode = episodes[i];
        }
    }

    return firstepisode;
};

/**
 * Takes a list of shows/movies/episodes (from an On Deck request, for example) and returns an array of show and movie names
 * @param {Object} apiResult - A list of shows/movies/episodes as returned by the Plex API
 * @returns {String[]} An array of show and movie names
 */
var getShowNamesFromList = function(apiResult) {
    var shows = [];

    for(i = 0; i < apiResult._children.length && i < 6; i++) {
        if(apiResult._children[i].type == 'episode') {
            shows.push(apiResult._children[i].grandparentTitle);
        } else if (apiResult._children[i].type == 'movie') {
            shows.push(apiResult._children[i].title);
        }
    }

    return shows;
};

var getShowFromSpokenName = function(spokenShowName, listOfShows) {
    return utils.findBestMatch(spokenShowName, listOfShows, function (show) {
        return show.title;
    });
};

module.exports = {
    getServers: getServers,
    getPlayers: getPlayers,
    startShow: startShow,
    getOnDeck: getOnDeck,
    getListOfTVShows: getListOfTVShows,
    getAllEpisodesOfShow: getAllEpisodesOfShow,
    playMedia: playMedia,
    getMachineIdentifier: getMachineIdentifier,
    getClientIP: getClientIP,
    filterEpisodesByExists: filterEpisodesByExists,
    filterEpisodesByBestRated: filterEpisodesByBestRated,
    findEpisodeWithOffset: findEpisodeWithOffset,
    getRandomEpisode: getRandomEpisode,
    getFirstUnwatched: getFirstUnwatched,
    getShowNamesFromList: getShowNamesFromList,
    getShowFromSpokenName: getShowFromSpokenName
};