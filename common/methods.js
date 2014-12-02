Meteor.methods({
  createCompetition: function(competitionName) {
    check(competitionName, String);
    if(competitionName.trim().length === 0) {
      throw new Meteor.Error(400, "Competition name must be nonempty");
    }

    if(!this.userId) {
      throw new Meteor.Error(401, "Must log in");
    }

    var user = Meteor.users.findOne({ _id: this.userId });
    if(!user.emails[0].verified) {
      throw new Meteor.Error(401, "Must verify email");
    }

    var competitionId = Competitions.insert({
      competitionName: competitionName,
      organizers: [ this.userId ],
      listed: false,
      startDate: new Date(),
    });
    return competitionId;
  },
  deleteCompetition: function(competitionId) {
    check(competitionId, String);
    throwIfCannotManageCompetition(this.userId, competitionId);

    Competitions.remove({ _id: competitionId });
    Rounds.remove({ competitionId: competitionId });
    Results.remove({ competitionId: competitionId });
    Groups.remove({ competitionId: competitionId });
  },
  addRound: function(competitionId, eventCode) {
    if(!canAddRound(this.userId, competitionId, eventCode)) {
      throw new Meteor.Error(400, "Cannot add another round");
    }

    // TODO - what happens if multiple users call this method at the same time?
    // It looks like meteor makes an effort to serve methods from a single user
    // in order, but I don't know if there is any guarantee of such across users
    // See http://docs.meteor.com/#method_unblock.

    var formatCode = wca.formatsByEventCode[eventCode][0];
    Rounds.insert({
      competitionId: competitionId,
      eventCode: eventCode,
      formatCode: formatCode,

      // These will be filled in by refreshRoundCodes, but
      // add valid value so the UI doesn't crap out.
      roundCode: 'f',
      nthRound: wca.MAX_ROUNDS_PER_EVENT,
    });

    Meteor.call('refreshRoundCodes', competitionId, eventCode);
  },
  addNonEventRound: function(competitionId, round) {
    check(competitionId, String);
    throwIfCannotManageCompetition(this.userId, competitionId);
    Rounds.insert({
      competitionId: competitionId,
      title: round.title,
      startMinutes: round.startMinutes,
      durationMinutes: round.durationMinutes,
    });
  },
  // TODO - i think this would be a bit cleaner if we just had a
  // removeLastRoundForEvent method or something. This might
  // require pulling non wca-event rounds out into a
  // separate collection.
  removeRound: function(roundId) {
    if(!canRemoveRound(this.userId, roundId)) {
      throw new Meteor.Error(400, "Cannot remove round. Make sure it is the last round for this event, and has no times entered.");
    }

    var round = Rounds.findOne({ _id: roundId });
    assert(round); // canRemoveRound checked that roundId is valid

    Rounds.remove({ _id: roundId });
    Groups.remove({ roundId: roundId });

    if(round.eventCode) {
      Meteor.call('refreshRoundCodes', round.competitionId, round.eventCode);
    }
  },
  refreshRoundCodes: function(competitionId, eventCode) {
    var rounds = Rounds.find({
      competitionId: competitionId,
      eventCode: eventCode
    }, {
      sort: {
        nthRound: 1,
        softCutoff: 1,
      }
    }).fetch();
    if(rounds.length > wca.MAX_ROUNDS_PER_EVENT) {
      throw new Meteor.Error(400, "Too many rounds");
    }
    rounds.forEach(function(round, nthRound) {
      // Note that we ignore the actual value of nthRound, and instead use the
      // index into rounds as the nthRound. This defragments any missing
      // rounds (not that that's something we expect to ever happen, since
      // removeRound only allows removal of the latest round).
      var supportedRoundsIndex;
      if(nthRound == rounds.length - 1) {
        supportedRoundsIndex = wca.MAX_ROUNDS_PER_EVENT - 1;
      } else {
        supportedRoundsIndex = nthRound;
      }
      var roundCodes = wca.supportedRounds[supportedRoundsIndex];
      var roundCode = round.softCutoff ? roundCodes.combined : roundCodes.uncombined;
      Rounds.update({
        _id: round._id
      }, {
        $set: {
          roundCode: roundCode,
          nthRound: nthRound
        }
      });
    });
  },
  addOrUpdateGroup: function(newGroup) {
    throwIfCannotManageCompetition(this.userId, newGroup.competitionId);
    var round = Rounds.findOne({ _id: newGroup.roundId });
    if(!round) {
      throw new Meteor.Error("Invalid roundId");
    }
    throwIfCannotManageCompetition(this.userId, round.competitionId);

    var existingGroup = Groups.findOne({
      roundId: newGroup.roundId,
      group: newGroup.group,
    });
    if(existingGroup) {
      console.warn("Clobbering existing group");
      console.warn(existingGroup);
      Groups.update({
        _id: existingGroup._id,
      }, {
        $set: newGroup,
      });
    } else {
      Groups.insert(newGroup);
    }
  },
  advanceCompetitorsFromRound: function(competitorCount, roundId) {
    var competitionId = getRoundAttribute(roundId, 'competitionId');
    throwIfCannotManageCompetition(this.userId, competitionId);

    var results = Results.find({
      roundId: roundId,
    }, {
      sort: {
        position: 1,
      }
    }).fetch();
    if(competitorCount < 0) {
      throw new Meteor.Error(400,
            'Cannot advance a negative number of competitors');
    }
    if(competitorCount > results.length) {
      throw new Meteor.Error(400,
            'Cannot advance more people than there are in round');
    }
    var eventCode = getRoundAttribute(roundId, 'eventCode');
    var nthRound = getRoundAttribute(roundId, 'nthRound');
    var nextRound = Rounds.findOne({
      competitionId: competitionId,
      eventCode: eventCode,
      nthRound: nthRound + 1,
    }, {
      fields: {
        _id: 1,
      }
    });
    if(!nextRound) {
      throw new Meteor.Error(404,
            'No next round found for roundId ' + roundId);
    }

    var desiredUserIds = [];
    for(var i = 0; i < competitorCount; i++) {
      var result = results[i];
      desiredUserIds.push(result.userId);
    }

    var actualUserIds = _.pluck(Results.find({
      roundId: nextRound._id,
    }).fetch(), 'userId');

    var userIdsToRemove = _.difference(actualUserIds, desiredUserIds);
    var userIdsToAdd = _.difference(desiredUserIds, actualUserIds);

    // We're ready to actually advance competitors to the next round!

    // First, remove any results that are currently in the next round that
    // shouldn't be.
    _.each(userIdsToRemove, function(userId) {
      Results.remove({
        competitionId: result.competitionId,
        roundId: nextRound._id,
        userId: userId,
      });
    });

    // Now copy competitorCount results from the current round to the next
    // round.
    _.each(userIdsToAdd, function(userId) {
      Results.insert({
        competitionId: result.competitionId,
        roundId: nextRound._id,
        userId: userId,
      });
    });
  },
});

if(Meteor.isServer) {
  var child_process = Npm.require('child_process');
  var path = Npm.require("path");
  var fs = Npm.require('fs');
  var os = Npm.require('os');
  var mkdirp = Meteor.npmRequire('mkdirp');

  var zipIdToFilename = function(zipId, userId) {
    var tmpdir = os.tmpdir();
    var filename = path.join(tmpdir, "tnoodlezips", userId, zipId + ".zip");
    return filename;
  };

  Meteor.methods({
    'requestVerificationEmail': function() {
      Accounts.sendVerificationEmail(this.userId);
    },
    'uploadTNoodleZip': function(zipData) {
      // TODO - this is pretty janky. What if the folder we try to create
      // exists, but isn't a folder? Permissions could also screw us up.
      // Ideally we would just decompress the zip file client side, but
      // there aren't any libraries for that yet.
      var id = Date.now();
      var zipFilename = zipIdToFilename(id, this.userId);
      mkdirp.sync(path.join(zipFilename, ".."));
      fs.writeFileSync(zipFilename, zipData, 'binary');
      return id;
    },
    'unzipTNoodleZip': function(zipId, pw) {
      var args = [];
      args.push('-p'); // extract to stdout

      // If you don't pass -P to unzip and try to unzip a password protected
      // zip file, it will prompt you for a password, causing the unzip process
      // to hang. By always passing something to -P, we will never get prompted
      // for a password, instead unzip may just fail to extract.
      args.push('-P');
      args.push(pw || "");

      var zipFilename = zipIdToFilename(zipId, this.userId);
      args.push(zipFilename);
      args.push('*.json'); // there should be exactly one json file in the zip
      function unzipAsync(cb) {
        child_process.execFile('unzip', args, function(error, stdout, stderr) {
          if(error) {
            // Error code 82 indicates bad password
            // See http://www.info-zip.org/FAQ.html
            if(error.code == 82) {
              cb("invalid-password");
            } else {
              cb("Unzip exited with error code " + error.code);
            }
          } else {
            cb(null, stdout);
          }
        });
      }
      var unzipSync = Meteor.wrapAsync(unzipAsync);
      try {
        var jsonStr = unzipSync();
        return jsonStr;
      } catch(e) {
        throw new Meteor.Error('unzip', e.message);
      }
    }
  });
}
